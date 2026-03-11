# Bitmap Collision Solver for Truchet Tile Curves

## Problem Statement

Given a set of **edge points (EPs)** on the perimeter of a polygon and a **non-crossing perfect matching** pairing them, find cubic Bezier curves connecting each matched pair such that:

1. Each curve starts perpendicular to its edge (tangent = inward normal)
2. No two curves overlap
3. Curves stay inside the polygon
4. Total "ink" (curve area) is maximized

The solver is **shape-agnostic** — it works on any convex polygon (squares, triangles, hexagons) given the polygon's corners and edge normals.

## Bezier Parameterization

Each curve connecting EP `a` to EP `b` is a cubic Bezier `(p0, p1, p2, p3)` where:

- `p0 = position(a)` — start point on the edge
- `p3 = position(b)` — end point on the edge
- `p1 = p0 + d0 * normal(edge_a)` — first control point, displaced inward
- `p2 = p3 + d1 * normal(edge_b)` — second control point, displaced inward

The two scalar parameters `(d0, d1)` fully determine the curve shape. The normal constraint ensures curves leave the edge perpendicularly, creating smooth joins with neighboring tiles.

### Ideal d (Circular Arc Approximation)

For each arc, we compute `d_ideal` — the `d` value that makes the Bezier approximate a circular arc. This is the "natural" shape for the curve:

1. Find the center of the circle passing through `p0` and `p3` with tangent directions matching the edge normals
2. Compute the subtended angle `θ`
3. Apply the standard formula: `d = (4/3) · r · tan(θ/4)`

When edge normals are parallel (same-edge pairs), the ideal arc is a semicircle with `d = (4/3) · r`.

### Control Point Constraints

Each control point must stay inside the polygon. The maximum allowable `d` for each EP is computed by **ray-polygon intersection**: from the EP position, cast a ray along the inward normal and find where it hits the opposite edge. This caps `d` so the control point never escapes the tile boundary.

Additionally, `d` is capped at `(2/3) · chord_length` (the semicircle limit for a Bezier).

## Quantization

The continuous `(d0, d1)` space is discretized into a small set of **levels** per arc:

- Levels span `[d_min, d_max]` uniformly, where `d_max` is the per-EP polygon constraint
- `d_ideal` is always included as a level
- Typical count: 4–12 levels, auto-tuned based on the number of arcs

Each `(d0_level, d1_level)` pair is a **variant** of the arc. With `L` levels per endpoint, each arc has up to `L²` variants.

## Bitmap Rasterization

Each variant is rasterized onto a binary bitmap of resolution `R × R` (typically 64–200px):

1. Sample the Bezier at `4R` points using De Casteljau evaluation
2. For each sample, set a square brush of `thickness × thickness` pixels
3. Store the result as a boolean bitmap

The bitmap is then **packed** into a `uint64` array using `numpy.packbits` for efficient bitwise operations.

### Auto-Tuning

Resolution and stroke width are derived from tile geometry to maintain a **3% stroke invariant**:

- `stroke_width = 3% × resolution` — curves occupy a consistent fraction of the tile
- Resolution is sized so adjacent same-edge curves have ≥2px clearance between their strokes
- Fewer quantization levels for tiles with more arcs (to bound search space)

## Overlap Detection

Two variants overlap if their bitmaps share any set pixel. This reduces to a **bitwise AND** of their packed `uint64` arrays:

```
overlap(a, b) = any(a[i] & b[i] for i in range(pack_len))
```

This is implemented as a numba-JIT kernel for speed.

## Constraint Solving

### Phase 1: Pairwise Compatibility

For every pair of arcs `(i, j)` and every pair of their variants `(vi, vj)`, precompute whether they overlap. This builds a 4D boolean compatibility table:

```
compat[i, j, vi, vj] = not overlap(bitmap[i][vi], bitmap[j][vj])
```

Parallelized across arc pairs using `numba.prange`.

### Phase 2: AC-3 Arc Consistency

Before searching, prune the variant space using the **AC-3 algorithm** (arc consistency from constraint satisfaction):

> A variant `vi` of arc `i` is **viable** only if, for every other arc `j`, there exists at least one viable variant `vj` of `j` that is compatible with `vi`.

Iterate until no more variants can be eliminated. This often dramatically reduces the search space (e.g., from 25 variants down to 4 per arc).

### Phase 3: Parallel Backtracking Search

Find the assignment of one variant per arc that:
- Has no pairwise overlaps
- Maximizes total ink (pixel count), with a symmetry penalty for `d0 ≠ d1`

The search uses **depth-first backtracking** with:

- **Most-constrained-first ordering**: arcs with fewer viable variants are placed first
- **Best-first variant ordering**: within each arc, variants are tried in decreasing score order
- **Parallel split**: the first arc's choices are distributed across threads via `numba.prange`
- **Composite bitmap**: a running OR of all placed bitmaps, enabling O(pack_len) overlap checks against the partial solution

The search is capped at `max_solutions` configurations and `max_nodes` tree nodes to bound runtime.

### Fallback: Stroke Reduction

If no solution is found at the initial stroke width, the solver **reduces stroke thickness** by 1px and retries. Thinner curves are less likely to overlap. This continues until a solution is found or stroke reaches 1px.

## Scoring

Each variant's score combines:

- **Ink**: `count_nonzero(bitmap)` — more pixels = larger, more visually prominent curve
- **Symmetry penalty**: `−2000 · (d0 − d1)²` — penalizes asymmetric curves, favoring the circular arc shape

The search maximizes total score across all arcs.

## Output

The solver returns, for each arc in matching order:

```
(p0, p1, p2, p3, d0, d1)
```

The four Bezier control points plus the two `d` scalars. This is the minimal representation — the full curve can be reconstructed from the EP positions, edge normals, and `(d0, d1)`.

## Complexity

| Parameter | Typical Range |
|-----------|--------------|
| EPs per tile | 4–60 |
| Arcs per tile | 2–30 |
| Variants per arc | 16–625 (before AC-3) |
| Variants per arc | 3–25 (after AC-3) |
| Bitmap resolution | 64–200px |
| Pack length | 8–625 uint64s |
| Solve time | 0.01–3s per tile |

The bottleneck is the backtracking search, which is exponential in the worst case but heavily pruned by AC-3 and the most-constrained-first heuristic. In practice, tiles with ≤30 EPs solve in under 3 seconds.

## Portability to Rust / C

The solver is designed around integer arrays, bitwise operations, and fixed-iteration loops — it maps almost directly to low-level code. The numba-JIT kernels are already written in a restricted subset of Python that mirrors C semantics: no heap allocation, no dynamic dispatch, no Python objects on the hot path.

### What maps directly

**Bitmap rasterization** (`_rasterize_bezier_jit`): Pure arithmetic — De Casteljau evaluation with fixed-point pixel coordinate conversion and a nested loop brush. This is textbook C. The only data structure is a stack-allocated 2D boolean array.

**Packed overlap** (`_packed_overlap_jit`): A single loop doing `a[i] & b[i]` with early exit. This is already optimal — it's what a C compiler would emit.

**Pairwise compatibility** (`_build_compat_jit`): Nested loops over arc pairs and variant pairs, calling the overlap check. The parallel outer loop (`numba.prange`) maps to `#pragma omp parallel for` in C or `rayon::par_iter` in Rust.

**AC-3 elimination** (`_eliminate_jit`): A fixed-point loop over a boolean array. No allocations, no complex data structures. Direct translation.

**Backtracking search** (`_search_subtree`, `_search_jit`): Stack-based DFS using integer arrays for state (`chosen`, `pos`, `composites`). The composite bitmap OR is the only "complex" operation. The parallel wrapper splits on the first arc's variants — same pattern as compatibility. All state is thread-local.

**Bit packing** (`pack_bitmap`): `numpy.packbits` is a convenience. In C/Rust you'd pack bits into `uint64` words manually — a single pass over the boolean array, shifting and OR-ing 64 bits at a time.

### Memory layout

The solver's core data structure is a 3D array:

```
all_packed[n_arcs][max_variants][pack_len]  — uint64
```

Typical sizes: `15 × 25 × 80 = 30,000 uint64s = 234KB`. This fits comfortably in L2 cache. The compatibility table is 4D boolean:

```
compat[n_arcs][n_arcs][max_variants][max_variants]  — bool
```

At `15 × 15 × 25 × 25 = 140,625 bytes = 137KB`. Also cache-friendly.

In C/Rust, both would be flat arrays with manual index arithmetic. No pointers-to-pointers, no indirection. The access patterns are sequential within each arc pair, which is good for prefetching.

### What needs rethinking

**Variant generation** (`build_arc_variants`): The Python code builds a list-of-lists of `(variant_tuple, numpy_array)` pairs. In C/Rust, you'd pre-allocate the `all_packed` array directly and rasterize into it in-place, eliminating the intermediate boolean bitmap and the packing step. Rasterize directly into packed `uint64` words:

```c
// Instead of: bitmap[y][x] = true; ... packbits(bitmap)
// Do: packed[y * width + x / 64] |= (1ULL << (x % 64));
```

This eliminates one full copy and the `R × R` boolean temporary.

**Ideal-d computation** (`compute_ideal_d_from_geometry`): Uses `atan`, `acos`, `hypot`, `sqrt`. All available in `<math.h>` / `std::f64`. The ray-polygon intersection (`max_d_for_polygon`) is a simple loop — no issues.

**Dynamic level generation** (`d_levels`): Uses a Python `set` for deduplication. In C/Rust, generate into a sorted array and deduplicate with a single pass. Or skip deduplication entirely — duplicates just produce redundant variants that AC-3 will prune.

**Non-crossing matching** (`random_ncm`): Recursive with dynamic list slicing. In C, use index ranges instead of sliced copies. In Rust, use `&[usize]` slices. The recursion depth is bounded by `n/2` (max ~30), so stack overflow isn't a concern.

### Parallelism

The Python version uses `numba.prange` which compiles to OpenMP-style threading. The mapping:

| Python (numba) | C | Rust |
|----------------|---|------|
| `numba.prange` | `#pragma omp parallel for` | `rayon::par_iter` |
| Thread-local arrays | Stack allocation inside loop | `Vec` per thread or stack |
| Shared read-only arrays | Pointer passing | `&[u64]` slices |

The parallelism is embarrassingly parallel in both the compatibility building and the search split — no synchronization needed beyond the final reduction (pick best ink across threads).

### Estimated line counts

| Component | Python+numba | C estimate | Rust estimate |
|-----------|-------------|------------|---------------|
| Rasterize | 30 lines | 25 lines | 25 lines |
| Pack + overlap | 15 lines | 10 lines | 10 lines |
| Build compat | 25 lines | 20 lines | 20 lines |
| AC-3 | 20 lines | 18 lines | 18 lines |
| Search | 80 lines | 75 lines | 75 lines |
| Variant gen | 40 lines | 30 lines | 30 lines |
| Geometry | 60 lines | 55 lines | 55 lines |
| **Total core** | **~270 lines** | **~233 lines** | **~233 lines** |

The Python version is slightly longer due to numpy ceremony. The core algorithm is ~250 lines in any language.

### What you gain from porting

**Startup time**: The Python version spends 0.1–2s on numba JIT compilation at first run (cached thereafter). A compiled binary has zero warmup.

**Memory control**: Direct control over allocation. The `all_packed` array can be a single `malloc` / stack allocation. No GC pressure, no numpy array headers.

**SIMD**: The packed overlap check (`a[i] & b[i]`) is a textbook case for SIMD. With AVX2, you process 4 `uint64` words per instruction (256 bits). With AVX-512, 8 words. The compiler will auto-vectorize the loop, but you can also use intrinsics for guaranteed vectorization. At `pack_len=80`, this reduces the overlap check from 80 iterations to 10–20.

**Deterministic performance**: No GIL, no GC pauses, no JIT recompilation. Solve times become predictable, which matters for real-time applications or blockchain verification.

**Embedded / WASM**: The solver has no dependencies beyond `<math.h>` and a threading library. It compiles to WebAssembly for browser-based rendering, or runs on embedded hardware for physical tile fabrication.

### What you don't gain

The algorithm is the same. The asymptotic complexity doesn't change. numba already compiles the hot loops to machine code that's within 1–2× of hand-written C. The practical speedup from porting is likely **2–5×** from reduced overhead, better memory layout, and SIMD — meaningful but not transformative. The real wins are deployment flexibility (no Python runtime) and predictable latency.
