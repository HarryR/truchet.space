#!/usr/bin/env python3
"""Truchet tile curves via bitmap collision detection.

Each arc has two control scalars (d0, d1) quantized to discrete levels.
For each quantized (d0, d1) pair, the Bezier is rasterized onto a bitmap.
Overlap between any two arcs is detected by bitwise AND of their bitmaps.
Exhaustive search finds compatible assignments maximizing total ink.

Usage:
    python3 tile_bez_bitbash.py [seed] [k] [levels] [resolution] [stroke_width]
"""

import os
import sys
import math
import random
import time
import csv
from datetime import datetime

import numpy as np
import numba

SOLVE_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "solve_log.csv")

Point = tuple[float, float]

CORNERS = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]

EDGE_NORMALS: list[Point] = [
    (0.0, 1.0),   # edge 0 (top):    points down
    (-1.0, 0.0),  # edge 1 (right):  points left
    (0.0, -1.0),  # edge 2 (bottom): points up
    (1.0, 0.0),   # edge 3 (left):   points right
]

PALETTE = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12",
           "#9b59b6", "#1abc9c", "#e67e22", "#34495e"]


def lerp(a: Point, b: Point, t: float) -> Point:
    return (a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1]))


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def catalan(n: int) -> int:
    if n <= 0: return 1
    c = 1
    for i in range(n):
        c = c * 2*(2*i+1) // (i+2)
    return c


def random_ncm(n: int, rng: random.Random) -> list[tuple[int, int]]:
    def _sample(pts: list[int]) -> list[tuple[int, int]]:
        if not pts: return []
        first = pts[0]
        choices: list[tuple[int, int]] = []
        for k in range(1, len(pts), 2):
            choices.append((k, catalan((k-1)//2) * catalan((len(pts)-k-1)//2)))
        total = sum(w for _, w in choices)
        r = rng.random() * total
        cumul, chosen = 0, choices[-1][0]
        for k, w in choices:
            cumul += w
            if r < cumul:
                chosen = k
                break
        return ([(first, pts[chosen])]
                + _sample(pts[1:chosen])
                + _sample(pts[chosen+1:]))
    return _sample(list(range(n)))


# ---------------------------------------------------------------------------
# EP geometry
# ---------------------------------------------------------------------------

def ep_positions(k: int) -> list[Point]:
    positions: list[Point] = []
    for ei in range(4):
        for j in range(k):
            t = (j + 1) / (k + 1)
            c0 = CORNERS[ei]
            c1 = CORNERS[(ei + 1) % 4]
            positions.append(lerp(c0, c1, t))
    return positions


def ep_edge(ep_idx: int, k: int) -> int:
    return ep_idx // k


# ---------------------------------------------------------------------------
# Ideal circular-arc d
# ---------------------------------------------------------------------------

ArcInfo = tuple[Point, Point, int, int, float]
# (p0, p3, edge_a, edge_b, d_ideal)


def compute_ideal_d_from_geometry(p0: Point, p3: Point, ea: int, eb: int,
                                  edge_normals: list[Point] | None = None
                                  ) -> ArcInfo:
    """Returns (p0, p3, edge_a, edge_b, d_ideal) from raw geometry."""
    _normals = edge_normals if edge_normals is not None else EDGE_NORMALS
    n0x, n0y = _normals[ea]
    n3x, n3y = _normals[eb]

    dx = p3[0] - p0[0]
    dy = p3[1] - p0[1]

    det = -n0y * n3x + n3y * n0x

    if abs(det) < 1e-10:
        chord = math.hypot(dx, dy)
        if ea == eb:
            r = chord / 2.0
            d = (4.0 / 3.0) * r
        else:
            d = chord / 3.0
        return (p0, p3, ea, eb, d)

    s_val = (dx * n3x + n3y * dy) / det
    cx = p0[0] + s_val * (-n0y)
    cy = p0[1] + s_val * n0x
    r = abs(s_val)

    if r < 1e-10:
        return (p0, p3, ea, eb, 0.3)

    v0x = (p0[0] - cx) / r
    v0y = (p0[1] - cy) / r
    v3x = (p3[0] - cx) / r
    v3y = (p3[1] - cy) / r
    cos_theta = max(-1.0, min(1.0, v0x * v3x + v0y * v3y))
    theta = math.acos(cos_theta)

    if theta < 1e-10:
        return (p0, p3, ea, eb, 0.3)

    d = (4.0 / 3.0) * r * math.tan(theta / 4.0)
    return (p0, p3, ea, eb, d)


def compute_ideal_d(ep_a: int, ep_b: int, k: int) -> ArcInfo:
    """Convenience wrapper for uniform k EPs per edge."""
    positions = ep_positions(k)
    p0 = positions[ep_a]
    p3 = positions[ep_b]
    ea = ep_edge(ep_a, k)
    eb = ep_edge(ep_b, k)
    return compute_ideal_d_from_geometry(p0, p3, ea, eb)


def make_bezier(p0: Point, p3: Point, ea: int, eb: int,
                d0: float, d1: float,
                edge_normals: list[Point] | None = None
                ) -> tuple[Point, Point, Point, Point]:
    _normals = edge_normals if edge_normals is not None else EDGE_NORMALS
    n0 = _normals[ea]
    n3 = _normals[eb]
    p1 = (p0[0] + d0 * n0[0], p0[1] + d0 * n0[1])
    p2 = (p3[0] + d1 * n3[0], p3[1] + d1 * n3[1])
    return (p0, p1, p2, p3)


# ---------------------------------------------------------------------------
# Bitmap rasterization (numba-accelerated)
# ---------------------------------------------------------------------------

@numba.njit(cache=True)
def _rasterize_bezier_jit(p0x: float, p0y: float, p1x: float, p1y: float,
                          p2x: float, p2y: float, p3x: float, p3y: float,
                          res: int, thickness: int) -> np.ndarray:  # type: ignore[type-arg]
    bitmap = np.zeros((res, res), dtype=numba.boolean)
    n_samples = res * 4
    half = thickness // 2
    scale = float(res - 1)

    for si in range(n_samples):
        t = si / (n_samples - 1)
        u = 1.0 - t
        x = u*u*u*p0x + 3.0*u*u*t*p1x + 3.0*u*t*t*p2x + t*t*t*p3x
        y = u*u*u*p0y + 3.0*u*u*t*p1y + 3.0*u*t*t*p2y + t*t*t*p3y

        px = int(x * scale + 0.5)
        py = int(y * scale + 0.5)

        for dy in range(-half, half + 1):
            ny = py + dy
            if ny < 0 or ny >= res:
                continue
            for dx in range(-half, half + 1):
                nx = px + dx
                if nx < 0 or nx >= res:
                    continue
                bitmap[ny, nx] = True

    return bitmap


def rasterize_bezier(p0: Point, p1: Point, p2: Point, p3: Point,
                     res: int, thickness: int = 2) -> np.ndarray:  # type: ignore[type-arg]
    return _rasterize_bezier_jit(p0[0], p0[1], p1[0], p1[1],
                                 p2[0], p2[1], p3[0], p3[1],
                                 res, thickness)


# ---------------------------------------------------------------------------
# Packed bitmap overlap (numba-accelerated)
# ---------------------------------------------------------------------------

@numba.njit(cache=True)
def _packed_overlap_jit(a: np.ndarray, b: np.ndarray) -> bool:  # type: ignore[type-arg]
    for i in range(len(a)):
        if a[i] & b[i]:
            return True
    return False


def pack_bitmap(bmp: np.ndarray) -> np.ndarray:  # type: ignore[type-arg]
    flat = bmp.ravel().astype(np.uint8)
    pad = (64 - len(flat) % 64) % 64
    if pad:
        flat = np.concatenate([flat, np.zeros(pad, dtype=np.uint8)])
    return np.packbits(flat).view(np.uint64)


def packed_overlap(a: np.ndarray, b: np.ndarray) -> bool:  # type: ignore[type-arg]
    return _packed_overlap_jit(a, b)


# ---------------------------------------------------------------------------
# Quantized d levels
# ---------------------------------------------------------------------------

def d_levels(d_ideal: float, n_levels: int,
             d_min: float = 0.05, d_max: float = 0.6) -> list[float]:
    """Generate quantized d values spanning [d_min, d_max].

    The ideal value is always included.
    """
    values: set[float] = set()
    for i in range(n_levels):
        t = i / max(n_levels - 1, 1)
        values.add(round(d_min + t * (d_max - d_min), 6))
    values.add(round(min(d_ideal, d_max), 6))
    result = sorted(values)
    return result


# ---------------------------------------------------------------------------
# Validity checks (analytical)
# ---------------------------------------------------------------------------

ArcVariant = tuple[int, int, float, float]  # (d0_idx, d1_idx, d0, d1)


def max_d_for_ep(pos: Point, normal: Point,
                 polygon_corners: list[Point] | None = None) -> float:
    """Max d such that control point pos + d*normal stays inside the tile.

    If polygon_corners is provided, uses ray-polygon intersection.
    Otherwise falls back to [0,1]^2 axis-aligned bounds.
    """
    if polygon_corners is not None:
        from tile_shapes import max_d_for_polygon
        return max_d_for_polygon(pos, normal, polygon_corners)
    d_max = float('inf')
    for axis in range(2):
        p = pos[axis]
        n = normal[axis]
        if n > 1e-12:
            d_max = min(d_max, (1.0 - p) / n)
        elif n < -1e-12:
            d_max = min(d_max, -p / n)
    return d_max


# ---------------------------------------------------------------------------
# Bitmap cache and search
# ---------------------------------------------------------------------------

def build_arc_variants(arc_info: list[tuple[Point, Point, int, int, float]],
                       n_levels: int, res: int, thickness: int,
                       edge_normals: list[Point] | None = None,
                       polygon_corners: list[Point] | None = None,
                       ) -> list[list[tuple[ArcVariant, np.ndarray]]] | None:  # type: ignore[type-arg]
    """Pre-compute all (d0, d1) variants and their bitmaps for each arc.

    Per-arc d_max is capped at 2/3 * chord length (semicircle limit).
    Variants with non-convex control polygons are rejected.
    Returns None if any arc has zero valid variants.
    """
    _normals = edge_normals if edge_normals is not None else EDGE_NORMALS
    all_variants: list[list[tuple[ArcVariant, np.ndarray]]] = []  # type: ignore[type-arg]
    n_rejected = 0

    for ai, (p0, p3, ea, eb, d_ideal) in enumerate(arc_info):
        chord = math.hypot(p3[0] - p0[0], p3[1] - p0[1])
        d_chord_max = (2.0 / 3.0) * chord

        n0 = _normals[ea]
        n3 = _normals[eb]
        d0_max = min(max_d_for_ep(p0, n0, polygon_corners), d_chord_max)
        d1_max = min(max_d_for_ep(p3, n3, polygon_corners), d_chord_max)

        levels_0 = d_levels(d_ideal, n_levels, d_max=d0_max)
        levels_1 = d_levels(d_ideal, n_levels, d_max=d1_max)
        variants: list[tuple[ArcVariant, np.ndarray]] = []  # type: ignore[type-arg]

        for i0, d0 in enumerate(levels_0):
            for i1, d1 in enumerate(levels_1):
                bez = make_bezier(p0, p3, ea, eb, d0, d1, edge_normals)
                bmp = rasterize_bezier(*bez, res, thickness)
                variant: ArcVariant = (i0, i1, d0, d1)
                variants.append((variant, bmp))

        all_variants.append(variants)
        print(f"    arc {ai}: d0_max={d0_max:.3f} d1_max={d1_max:.3f}, "
              f"{len(variants)} valid variants")

        if len(variants) == 0:
            print(f"  FAILED: arc {ai} has no valid variants")
            return None

    return all_variants


def score_variant_pixels(bmp: np.ndarray) -> int:  # type: ignore[type-arg]
    """Higher is better. More pixels = bigger curve = fills more space."""
    return int(np.count_nonzero(bmp))



@numba.njit(parallel=True, cache=True)
def _build_compat_jit(all_packed: np.ndarray,  # type: ignore[type-arg]
                      n_variants: np.ndarray,  # type: ignore[type-arg]
                      n_arcs: int, pack_len: int,
                      max_variants: int
                      ) -> np.ndarray:  # type: ignore[type-arg]
    """Build pairwise compatibility: compat[i,j,vi,vj] = no overlap."""
    compat = np.ones((n_arcs, n_arcs, max_variants, max_variants),
                     dtype=numba.boolean)
    # Flatten arc pairs for parallel iteration
    n_pairs = n_arcs * (n_arcs - 1) // 2
    for idx in numba.prange(n_pairs):
        # Recover (i, j) from flat index using quadratic formula
        # idx = i*n_arcs - i*(i+1)/2 + (j - i - 1)
        i = int(n_arcs - 1 - math.floor(
            math.sqrt(-8.0 * idx + 4.0 * n_arcs * (n_arcs - 1) - 7.0) / 2.0 - 0.5))
        j = int(idx + i + 1 - n_arcs * (n_arcs - 1) // 2 +
                (n_arcs - i) * ((n_arcs - i) - 1) // 2)
        for vi in range(n_variants[i]):
            for vj in range(n_variants[j]):
                for w in range(pack_len):
                    if all_packed[i, vi, w] & all_packed[j, vj, w]:
                        compat[i, j, vi, vj] = False
                        compat[j, i, vj, vi] = False
                        break
    return compat


@numba.njit(cache=True)
def _eliminate_jit(compat: np.ndarray,  # type: ignore[type-arg]
                   n_variants: np.ndarray,  # type: ignore[type-arg]
                   n_arcs: int, max_variants: int
                   ) -> np.ndarray:  # type: ignore[type-arg]
    """AC-3 arc consistency elimination. Returns viable mask."""
    viable = np.zeros((n_arcs, max_variants), dtype=numba.boolean)
    for i in range(n_arcs):
        for vi in range(n_variants[i]):
            viable[i, vi] = True

    changed = True
    while changed:
        changed = False
        for i in range(n_arcs):
            for vi in range(n_variants[i]):
                if not viable[i, vi]:
                    continue
                for j in range(n_arcs):
                    if i == j:
                        continue
                    has_compat = False
                    for vj in range(n_variants[j]):
                        if viable[j, vj] and compat[i, j, vi, vj]:
                            has_compat = True
                            break
                    if not has_compat:
                        viable[i, vi] = False
                        changed = True
                        break
    return viable


@numba.njit(cache=True)
def _search_subtree(all_packed: np.ndarray,  # type: ignore[type-arg]
                    viable_lists: np.ndarray,  # type: ignore[type-arg]
                    n_viable: np.ndarray,  # type: ignore[type-arg]
                    pixel_counts: np.ndarray,  # type: ignore[type-arg]
                    order: np.ndarray,  # type: ignore[type-arg]
                    n_arcs: int, pack_len: int,
                    max_solutions: int,
                    init_composite: np.ndarray,  # type: ignore[type-arg]
                    init_chosen: np.ndarray,  # type: ignore[type-arg]
                    start_depth: int,
                    max_nodes: int,
                    ) -> tuple[np.ndarray, int, int]:  # type: ignore[type-arg]
    """Search a subtree from a given starting state."""
    chosen = init_chosen.copy()
    best_chosen = np.full(n_arcs, -1, dtype=np.int32)
    composites = np.zeros((n_arcs + 1, pack_len), dtype=np.uint64)
    composites[start_depth, :] = init_composite
    pos = np.zeros(n_arcs, dtype=np.int32)

    best_ink = -1
    n_found = 0
    nodes = 0
    depth = start_depth

    while depth >= start_depth:
        if n_found >= max_solutions:
            break
        nodes += 1
        if max_nodes > 0 and nodes >= max_nodes:
            break

        if depth == n_arcs:
            n_found += 1
            ink = 0
            for i in range(n_arcs):
                ink += pixel_counts[i, chosen[i]]
            if ink > best_ink:
                best_ink = ink
                for i in range(n_arcs):
                    best_chosen[i] = chosen[i]
            depth -= 1
            if depth >= start_depth:
                chosen[order[depth]] = -1
                pos[depth] += 1
            continue

        ai = order[depth]
        found_next = False

        while pos[depth] < n_viable[ai]:
            vi = viable_lists[ai, pos[depth]]

            overlaps = False
            for w in range(pack_len):
                if all_packed[ai, vi, w] & composites[depth, w]:
                    overlaps = True
                    break

            if not overlaps:
                chosen[ai] = vi
                for w in range(pack_len):
                    composites[depth + 1, w] = (
                        composites[depth, w] | all_packed[ai, vi, w])
                depth += 1
                pos[depth] = 0
                found_next = True
                break

            pos[depth] += 1

        if not found_next:
            chosen[ai] = -1
            depth -= 1
            if depth >= start_depth:
                pos[depth] += 1

    return best_chosen, best_ink, n_found


@numba.njit(parallel=True, cache=True)
def _search_jit(all_packed: np.ndarray,  # type: ignore[type-arg]
                viable_lists: np.ndarray,  # type: ignore[type-arg]
                n_viable: np.ndarray,  # type: ignore[type-arg]
                pixel_counts: np.ndarray,  # type: ignore[type-arg]
                order: np.ndarray,  # type: ignore[type-arg]
                n_arcs: int, pack_len: int,
                max_solutions: int,
                max_nodes: int
                ) -> tuple[np.ndarray, int, int]:  # type: ignore[type-arg]
    """Parallel backtracking: split first arc's choices across threads."""
    first_arc = order[0]
    n_first = n_viable[first_arc]

    # Per-thread results
    thread_best = np.full((n_first, n_arcs), -1, dtype=np.int32)
    thread_ink = np.full(n_first, -1, dtype=np.int64)
    thread_count = np.zeros(n_first, dtype=np.int64)

    for fi in numba.prange(n_first):
        vi = viable_lists[first_arc, fi]

        # Set up initial state with first arc placed
        init_chosen = np.full(n_arcs, -1, dtype=np.int32)
        init_chosen[first_arc] = vi
        init_composite = all_packed[first_arc, vi, :].copy()

        best_c, best_i, n_f = _search_subtree(
            all_packed, viable_lists, n_viable, pixel_counts,
            order, n_arcs, pack_len, max_solutions,
            init_composite, init_chosen, 1, max_nodes)

        thread_best[fi, :] = best_c
        thread_ink[fi] = best_i
        thread_count[fi] = n_f

    # Combine: pick the thread with best ink
    overall_best = np.full(n_arcs, -1, dtype=np.int32)
    overall_ink = np.int64(-1)
    overall_count = np.int64(0)

    for fi in range(n_first):
        overall_count += thread_count[fi]
        if thread_ink[fi] > overall_ink:
            overall_ink = thread_ink[fi]
            overall_best[:] = thread_best[fi, :]

    return overall_best, int(overall_ink), int(overall_count)


def search_assignment(
        all_variants: list[list[tuple[ArcVariant, np.ndarray]]],  # type: ignore[type-arg]
        arc_info: list[tuple[Point, Point, int, int, float]],
        bmp_res: int,
        max_solutions: int = 1000,
        ) -> list[int]:
    """JIT-compiled compat + AC-3 + backtracking search."""
    n_arcs = len(all_variants)
    max_variants = max(len(v) for v in all_variants)

    # Pack all variant bitmaps into 3D array
    sample_packed = pack_bitmap(all_variants[0][0][1])
    pack_len = len(sample_packed)
    all_packed = np.zeros((n_arcs, max_variants, pack_len), dtype=np.uint64)
    n_variants_arr = np.zeros(n_arcs, dtype=np.int32)
    for i in range(n_arcs):
        n_variants_arr[i] = len(all_variants[i])
        for vi in range(len(all_variants[i])):
            all_packed[i, vi, :] = pack_bitmap(all_variants[i][vi][1])

    # JIT: build pairwise compatibility
    print("  building compatibility (JIT)...", end=" ", flush=True)
    t0 = time.perf_counter()
    compat = _build_compat_jit(all_packed, n_variants_arr,
                                n_arcs, pack_len, max_variants)
    print(f"{time.perf_counter() - t0:.2f}s")

    # JIT: AC-3 elimination
    print("  arc consistency (JIT)...", end=" ", flush=True)
    t0 = time.perf_counter()
    viable_mask = _eliminate_jit(compat, n_variants_arr,
                                 n_arcs, max_variants)
    t_ac3 = time.perf_counter() - t0

    # Count viable per arc
    total_viable = 0
    for i in range(n_arcs):
        n_v = 0
        for vi in range(n_variants_arr[i]):
            if viable_mask[i, vi]:
                n_v += 1
        total_viable += n_v
        if n_v == 0:
            print(f"\n  WARNING: arc {i} has NO viable variants after AC-3")
        elif n_v < n_variants_arr[i]:
            print(f"\n    arc {i}: {n_v}/{n_variants_arr[i]}", end="")
    print(f"  {total_viable} viable in {t_ac3:.2f}s")

    # Pre-compute combined score: ink + symmetry bonus
    # Penalize d0 != d1: score = pixels - weight * (d0 - d1)^2 * res^2
    # Penalize d0 != d1: penalty ~ 500 pixels when |d0-d1|=0.5
    sym_scale = 2000
    pixel_counts_arr = np.zeros((n_arcs, max_variants), dtype=np.int32)
    for i in range(n_arcs):
        for vi in range(len(all_variants[i])):
            pixels = score_variant_pixels(all_variants[i][vi][1])
            d0 = all_variants[i][vi][0][2]
            d1 = all_variants[i][vi][0][3]
            dd = d0 - d1
            penalty = int(sym_scale * dd * dd)
            pixel_counts_arr[i, vi] = pixels - penalty

    # Build viable lists sorted by score (best first)
    viable_arr = np.zeros((n_arcs, max_variants), dtype=np.int32)
    n_viable_arr = np.zeros(n_arcs, dtype=np.int32)
    for i in range(n_arcs):
        viable_indices = [vi for vi in range(n_variants_arr[i])
                          if viable_mask[i, vi]]
        viable_indices.sort(key=lambda vi: pixel_counts_arr[i, vi],
                            reverse=True)
        n_viable_arr[i] = len(viable_indices)
        for j, vi in enumerate(viable_indices):
            viable_arr[i, j] = vi

    if any(n_viable_arr[i] == 0 for i in range(n_arcs)):
        return [-1] * n_arcs

    # Order arcs: most constrained first
    order = sorted(range(n_arcs), key=lambda i: int(n_viable_arr[i]))
    order_arr = np.array(order, dtype=np.int32)

    print("  searching (JIT)...", end=" ", flush=True)
    t0 = time.perf_counter()
    max_nodes = 500_000
    best_chosen, best_ink, n_found = _search_jit(
        all_packed, viable_arr, n_viable_arr, pixel_counts_arr,
        order_arr, n_arcs, pack_len, max_solutions, max_nodes)
    t_search = time.perf_counter() - t0

    if n_found == 0:
        print(f"no solution in {t_search:.2f}s")
        return [-1] * n_arcs

    capped = " (capped)" if n_found >= max_solutions else ""
    print(f"{n_found} configs{capped}, best ink={best_ink}, "
          f"in {t_search:.2f}s")

    return [int(best_chosen[i]) for i in range(n_arcs)]


# ---------------------------------------------------------------------------
# SVG rendering
# ---------------------------------------------------------------------------

def bezier_to_svg_d(p0: Point, p1: Point, p2: Point, p3: Point,
                    ox: float, oy: float, sc: float) -> str:
    return (f"M {ox + p0[0]*sc:.2f},{oy + p0[1]*sc:.2f} "
            f"C {ox + p1[0]*sc:.2f},{oy + p1[1]*sc:.2f} "
            f"  {ox + p2[0]*sc:.2f},{oy + p2[1]*sc:.2f} "
            f"  {ox + p3[0]*sc:.2f},{oy + p3[1]*sc:.2f}")


def render_svg(matching: list[tuple[int, int]], k: int,
               beziers: list[tuple[Point, Point, Point, Point]],
               d0s: list[float], d1s: list[float],
               path: str,
               scale: float = 500.0, margin: float = 40.0) -> None:
    w = margin * 2 + scale
    h = margin * 2 + scale

    lines: list[str] = []
    lines.append('<?xml version="1.0" encoding="UTF-8"?>')
    lines.append(f'<svg xmlns="http://www.w3.org/2000/svg" '
                 f'width="{w:.0f}" height="{h:.0f}" '
                 f'viewBox="0 0 {w:.1f} {h:.1f}">')
    lines.append(f'<rect width="{w:.1f}" height="{h:.1f}" fill="#f8f8f8"/>')

    ox, oy, sc = margin, margin, scale

    lines.append(f'<rect x="{ox}" y="{oy}" width="{sc}" height="{sc}" '
                 f'fill="#ecf0f1" stroke="#333" stroke-width="1"/>')

    # EP tick marks
    positions = ep_positions(k)
    outward: list[Point] = [(0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)]
    tick_len = 8.0

    for ei in range(len(positions)):
        px, py = positions[ei]
        edge = ep_edge(ei, k)
        nx, ny = outward[edge]
        sx = ox + px * sc
        sy = oy + py * sc
        lines.append(f'<line x1="{sx:.1f}" y1="{sy:.1f}" '
                     f'x2="{sx + nx*tick_len:.1f}" y2="{sy + ny*tick_len:.1f}" '
                     f'stroke="#999" stroke-width="1.5" stroke-linecap="round"/>')
        lines.append(f'<text x="{sx + nx*(tick_len+8):.1f}" '
                     f'y="{sy + ny*(tick_len+8) + 3:.1f}" '
                     f'text-anchor="middle" font-size="8" fill="#999" '
                     f'font-family="monospace">{ei}</text>')

    # Bezier arcs
    for ai, (a, b) in enumerate(matching):
        color = PALETTE[ai % len(PALETTE)]
        p0, p1, p2, p3 = beziers[ai]

        ea = ep_edge(a, k)
        eb = ep_edge(b, k)

        lines.append(f'<!-- arc {ai}: ({a},{b}) edges {ea}->{eb} '
                     f'd0={d0s[ai]:.4f} d1={d1s[ai]:.4f} -->')
        d = bezier_to_svg_d(p0, p1, p2, p3, ox, oy, sc)
        lines.append(f'<path d="{d}" fill="none" '
                     f'stroke="white" stroke-width="4" '
                     f'stroke-linecap="round"/>')
        lines.append(f'<path d="{d}" fill="none" '
                     f'stroke="{color}" stroke-width="2" '
                     f'stroke-linecap="round"/>')

        # Color the EP ticks
        for pt in [p0, p3]:
            edge = ep_edge(a if pt == p0 else b, k)
            nx, ny = outward[edge]
            sx = ox + pt[0] * sc
            sy = oy + pt[1] * sc
            lines.append(f'<line x1="{sx:.1f}" y1="{sy:.1f}" '
                         f'x2="{sx + nx*tick_len:.1f}" '
                         f'y2="{sy + ny*tick_len:.1f}" '
                         f'stroke="{color}" stroke-width="2.5" '
                         f'stroke-linecap="round"/>')

    lines.append('</svg>')

    with open(path, "w") as f:
        f.write("\n".join(lines))
    sz = os.path.getsize(path)
    print(f"  wrote {path} ({sz // 1024}KB)")


# ---------------------------------------------------------------------------
# Library API
# ---------------------------------------------------------------------------

ArcResult = tuple[Point, Point, Point, Point, float, float]
# (p0, p1, p2, p3, d0, d1) — Bezier control points + d values


def warmup_jit() -> None:
    """Pre-compile all numba kernels. Call once at startup."""
    _rasterize_bezier_jit(0.0, 0.0, 0.1, 0.1, 0.9, 0.9, 1.0, 1.0, 10, 1)
    _packed_overlap_jit(np.zeros(1, dtype=np.uint64),
                        np.zeros(1, dtype=np.uint64))
    _ap = np.zeros((1, 1, 1), dtype=np.uint64)
    _nv = np.ones(1, dtype=np.int32)
    _build_compat_jit(_ap, _nv, 1, 1, 1)
    _eliminate_jit(np.ones((1, 1, 1, 1), dtype=np.bool_), _nv, 1, 1)
    _vl = np.zeros((1, 1), dtype=np.int32)
    _pc = np.zeros((1, 1), dtype=np.int32)
    _ord = np.zeros(1, dtype=np.int32)
    _ic = np.zeros(1, dtype=np.uint64)
    _ich = np.full(1, -1, dtype=np.int32)
    _search_subtree(_ap, _vl, _nv, _pc, _ord, 1, 1, 1, _ic, _ich, 0, 100)
    _search_jit(_ap, _vl, _nv, _pc, _ord, 1, 1, 1, 100)


_LOG_FIELDS = ["timestamp", "n_eps", "n_arcs", "n_levels", "bmp_res",
               "init_stroke", "final_stroke", "attempts", "ok", "t_total",
               "matching"]


def _log_solve(**kwargs: object) -> None:
    """Append one row to the solve log CSV."""
    write_header = not os.path.exists(SOLVE_LOG)
    with open(SOLVE_LOG, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=_LOG_FIELDS)
        if write_header:
            w.writeheader()
        row = {"timestamp": datetime.now().isoformat(timespec="seconds"),
               **kwargs}
        row["t_total"] = f"{row['t_total']:.3f}"
        w.writerow(row)


def _compute_min_gap(positions: list[Point], edges: list[int]) -> float:
    """Minimum distance between adjacent EPs on the same edge."""
    min_gap = 1.0
    for i in range(len(positions)):
        for j in range(i + 1, len(positions)):
            if edges[i] != edges[j]:
                continue
            d = math.hypot(positions[i][0] - positions[j][0],
                           positions[i][1] - positions[j][1])
            if d > 1e-9 and d < min_gap:
                min_gap = d
    return min_gap


REL_STROKE = 0.03  # 3% invariant: curve thickness as fraction of tile


def auto_tune(n_arcs: int, min_gap: float,
              ) -> tuple[int, int, int]:
    """Pick (n_levels, bmp_res, stroke_width) from tile geometry.

    Maintains REL_STROKE (3%) invariant. Resolution is sized so that:
    - Stroke is at least 2px
    - Adjacent same-edge curves have >=2px clear between their strokes
    - Fewer levels for more arcs (search space is levels^(2*arcs))
    """
    n_levels = max(4, 12 - n_arcs)

    # res from stroke minimum: need 2px at 3% → res >= 67
    res_from_stroke = math.ceil(2.0 / REL_STROKE)

    # res from gap: adjacent curves need 2px clear after strokes
    # min_gap * res - 2 * (REL_STROKE * res) >= 2
    # res * (min_gap - 2 * REL_STROKE) >= 2
    gap_margin = min_gap - 2 * REL_STROKE
    res_from_gap = math.ceil(2.0 / gap_margin) if gap_margin > 0.01 else 200

    bmp_res = max(res_from_stroke, res_from_gap)
    stroke_width = max(2, round(REL_STROKE * bmp_res))

    return n_levels, bmp_res, stroke_width


def solve_tile_general(matching: list[tuple[int, int]],
                       positions: list[Point],
                       edges: list[int],
                       n_levels: int | None = None,
                       bmp_res: int | None = None,
                       verbose: bool = True,
                       stroke_width: int | None = None,
                       edge_normals: list[Point] | None = None,
                       polygon_corners: list[Point] | None = None,
                       ) -> list[ArcResult]:
    """Find non-overlapping Bezier curves for arbitrary EP layout.

    Args:
        matching: list of (ep_a, ep_b) pairs to connect
        positions: position of each EP on the tile perimeter
        edges: which edge each EP belongs to
        n_levels: quantization levels (None = auto)
        bmp_res: bitmap resolution (None = auto)
        verbose: print progress
        stroke_width: starting stroke width in pixels (None = auto)
        edge_normals: inward-pointing normals per edge (None = square)
        polygon_corners: tile polygon vertices (None = square [0,1]^2)

    Returns:
        List of ArcResult tuples, one per arc in matching order.
    """
    n_arcs = len(matching)
    n_eps = len(positions)
    t_start = time.perf_counter()

    # Auto-tune from geometry
    min_gap = _compute_min_gap(positions, edges)
    auto_levels, auto_res, auto_stroke = auto_tune(n_arcs, min_gap)
    if n_levels is None:
        n_levels = auto_levels
    if bmp_res is None:
        bmp_res = auto_res
    if stroke_width is None:
        thickness = auto_stroke
    else:
        thickness = stroke_width

    if verbose:
        rel = thickness / bmp_res * 100
        print(f"  auto-tune: {n_arcs} arcs, min_gap={min_gap:.3f}, "
              f"levels={n_levels}, res={bmp_res}, "
              f"stroke={thickness}px ({rel:.1f}%)")

    # Compute arc geometry from provided positions and edges
    arc_info: list[ArcInfo] = []
    for a, b in matching:
        arc_info.append(compute_ideal_d_from_geometry(
            positions[a], positions[b], edges[a], edges[b], edge_normals))
    all_variants = None
    chosen = None
    final_stroke = thickness
    attempts = 0

    for attempt in range(thickness):
        stroke_w = thickness - attempt
        if stroke_w < 1:
            break
        attempts = attempt + 1
        final_stroke = stroke_w
        if verbose:
            print(f"  attempt {attempt}: stroke={stroke_w}px, "
                  f"levels={n_levels}, res={bmp_res}")

        t0 = time.perf_counter()
        all_variants = build_arc_variants(
            arc_info, n_levels, bmp_res, stroke_w,
            edge_normals, polygon_corners)
        t_build = time.perf_counter() - t0

        if all_variants is None:
            if verbose:
                print(f"  no valid variants, reducing stroke...")
            continue

        total_variants = sum(len(v) for v in all_variants)
        if verbose:
            print(f"  {total_variants} variants in {t_build:.2f}s")

        chosen = search_assignment(all_variants, arc_info, bmp_res)

        if all(c >= 0 for c in chosen):
            break
        if verbose:
            print(f"  no solution, reducing stroke...")
        all_variants = None
        chosen = None

    t_total = time.perf_counter() - t_start
    ok = all_variants is not None and chosen is not None and all(c >= 0 for c in (chosen or []))

    # Log to CSV
    _log_solve(n_eps=n_eps, n_arcs=n_arcs, n_levels=n_levels,
               bmp_res=bmp_res, init_stroke=thickness,
               final_stroke=final_stroke, attempts=attempts,
               ok=ok, t_total=t_total,
               matching=matching)

    if not ok:
        raise RuntimeError("Could not find valid configuration")

    assert all_variants is not None and chosen is not None

    # Build results
    results: list[ArcResult] = []
    for ai in range(n_arcs):
        variant = all_variants[ai][chosen[ai]][0]
        _, _, d0, d1 = variant
        p0, p3, ea, eb, _ = arc_info[ai]
        bez = make_bezier(p0, p3, ea, eb, d0, d1, edge_normals)
        results.append((*bez, d0, d1))

    return results


def solve_tile(matching: list[tuple[int, int]], k: int,
               n_levels: int = 10, bmp_res: int = 200,
               verbose: bool = True,
               stroke_width: int | None = None) -> list[ArcResult]:
    """Convenience wrapper for uniform k EPs per edge."""
    positions = ep_positions(k)
    edge_list = [ep_edge(i, k) for i in range(4 * k)]
    return solve_tile_general(matching, positions, edge_list,
                              n_levels, bmp_res, verbose, stroke_width)


# ---------------------------------------------------------------------------
# Main (CLI)
# ---------------------------------------------------------------------------

def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    seed = int(args[0]) if len(args) > 0 else 20
    k = int(args[1]) if len(args) > 1 else 3
    n_levels = int(args[2]) if len(args) > 2 else 10
    bmp_res = int(args[3]) if len(args) > 3 else 200
    stroke_w = int(args[4]) if len(args) > 4 else 0  # 0 = auto

    rng = random.Random(seed)
    n = 4 * k
    matching = random_ncm(n, rng)

    print(f"Seed {seed}, k={k}, {n} EPs, {len(matching)} arcs")
    print(f"  matching: {matching}")
    print(f"  levels={n_levels}, bitmap={bmp_res}x{bmp_res}, "
          f"stroke={stroke_w or 'auto'}")

    print("  compiling JIT kernels...", end=" ", flush=True)
    t0 = time.perf_counter()
    warmup_jit()
    print(f"{time.perf_counter() - t0:.2f}s")

    results = solve_tile(matching, k, n_levels, bmp_res,
                         stroke_width=stroke_w or None)

    beziers: list[tuple[Point, Point, Point, Point]] = []
    d0s: list[float] = []
    d1s: list[float] = []
    for ai, (p0, p1, p2, p3, d0, d1) in enumerate(results):
        beziers.append((p0, p1, p2, p3))
        d0s.append(d0)
        d1s.append(d1)
        a, b = matching[ai]
        arc_info = compute_ideal_d(a, b, k)
        d_ideal = arc_info[4]
        s0 = d0 / d_ideal if d_ideal > 0 else 0
        s1 = d1 / d_ideal if d_ideal > 0 else 0
        print(f"  arc {ai} ({a},{b}): d0={d0:.4f} ({s0:.1%}), "
              f"d1={d1:.4f} ({s1:.1%})")

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "tile_bez_bitbash.svg")
    render_svg(matching, k, beziers, d0s, d1s, out)


if __name__ == "__main__":
    main()
