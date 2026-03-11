# Tile Recovery: JSON to SVG

How to reconstruct and render a single Truchet tile from its compact JSON representation.

## JSON format

```json
{
  "config": {
    "shape": "square",
    "w": 4, "h": 4,
    "eps": [3, 3],
    "total_eps": 12,
    "n_levels": 6
  },
  "tiles": [
    ["42", [2, 3], [1, 1], [3, 2], [2, 3], [3, 3], [2, 2]],
    ...
  ]
}
```

Each tile is: `[catalan_index, [d0_idx, d1_idx], ...]`

- `catalan_index` — string-encoded integer identifying the non-crossing matching
- One `[d0_idx, d1_idx]` pair per arc — indices into quantized displacement level arrays

The config is shared across all tiles in the grid.

## Recovery pipeline

### Step 1: Polygon geometry

Build the unit polygon from `config.shape`:

| Shape    | Corners (CCW)                                |
|----------|----------------------------------------------|
| square   | (0,0), (1,0), (1,1), (0,1)                  |
| triangle up   | (0, h), (1, h), (0.5, 0) where h = sqrt(3)/2 |
| triangle down | (1, 0), (0, 0), (0.5, h)                    |
| hexagon  | 6 vertices centred at (0.5, h/2) with radius 0.5 |

For each edge, compute the **inward normal**: rotate the edge vector 90deg, normalize, flip if pointing away from centroid.

### Step 2: Edge point (EP) placement

The `eps` array gives per-unique-edge EP counts:
- **square**: `eps=[k1, k2]` → edge config `[k1, k2, k1, k2]` (bottom, right, top, left)
- **triangle**: `eps=[k0, k1, k2]` → edge config `[k0, k1, k2]`
- **hexagon**: `eps=[ka, kb, kc]` → edge config `[ka, kb, kc, ka, kb, kc]`

For each edge with `k` EPs, place points at positions `lerp(corner_i, corner_{i+1}, j/(k+1))` for j = 1..k. Traverse edges in order; this gives `total_eps` points numbered 0..total_eps-1 around the perimeter.

Also build `edge_index[i]` — which edge each EP sits on.

### Step 3: Unrank the matching

The `catalan_index` identifies which non-crossing perfect matching to use, out of C(total_eps/2) possibilities.

**Unranking algorithm** (inverse of the ranking in the generator):

```
function unrank(pts[0..n-1], rank) → pairs:
    if n == 0: return []
    first = pts[0]
    for k = 1, 3, 5, ...:
        weight = C((k-1)/2) * C((n-k-1)/2)
        if rank < weight:
            partner = pts[k]
            inside_rank  = rank / C((n-k-1)/2)
            outside_rank = rank % C((n-k-1)/2)
            return [(first, partner)]
                 + unrank(pts[1..k-1], inside_rank)
                 + unrank(pts[k+1..n-1], outside_rank)
        rank -= weight
```

This produces `n_arcs = total_eps / 2` pairs. Each pair `(a, b)` with `a < b` is one arc connecting EP `a` to EP `b`.

### Step 4: Per-arc geometry

For each arc `(a, b)`:

1. **Endpoints**: `p0 = positions[a]`, `p3 = positions[b]`
2. **Edge indices**: `ea = edge_index[a]`, `eb = edge_index[b]`
3. **Ideal displacement** (`compute_ideal_d`):
   - Find the circular arc centre from the two edge normals
   - `d_ideal = (4/3) * r * tan(theta/4)` where `r` is the arc radius and `theta` is the subtended angle
   - Degenerate cases: parallel normals → `chord/3` or `(4/3)*(chord/2)` for same-edge
4. **Max displacement** (`max_d_for_polygon`):
   - Ray-cast from each endpoint along its inward normal
   - `d0_max` = distance to nearest polygon edge intersection from `p0`
   - `d1_max` = distance to nearest polygon edge intersection from `p3`
   - Cap both at `(2/3) * chord_length`

### Step 5: Compute displacement levels

For each arc, build the level arrays using `n_levels` from config:

```
function compute_d_levels(d_ideal, n_levels, d_min=0.05, d_max) → levels[]:
    // n_levels uniform steps from d_min to d_max
    for i in 0..n_levels-1:
        t = i / (n_levels - 1)    // or 0 if n_levels == 1
        val = round((d_min + t * (d_max - d_min)) * 1e6) / 1e6
        append val if not duplicate

    // Insert d_ideal (capped to d_max)
    ideal_capped = round(min(d_ideal, d_max) * 1e6) / 1e6
    append if not duplicate

    sort ascending
    return levels
```

This gives `levels_0` (using `d0_max`) and `levels_1` (using `d1_max`) per arc.

### Step 6: Bezier control points

For each arc, look up the actual displacements:

```
d0 = levels_0[d0_idx]
d1 = levels_1[d1_idx]
```

Then the cubic Bezier control points are:

```
p0 = positions[a]                              // on-curve start
p1 = p0 + d0 * normal[ea]                      // control point 1
p2 = p3 + d1 * normal[eb]                      // control point 2
p3 = positions[b]                              // on-curve end
```

### Step 7: Nesting tree and coloring

To fill the regions correctly, compute arc nesting:

1. Normalize each pair to `(lo, hi)` where `lo = min(a,b)`, `hi = max(a,b)`
2. Arc `i` is nested inside arc `j` if `lo[j] < lo[i]` and `hi[i] < hi[j]`
3. Parent of `i` = the tightest enclosing arc (smallest `hi[j] - lo[j]` among enclosers)
4. Depth of `i` = number of ancestors to root

**Polarity** is a property of the tile's grid position, not stored per-tile:
- **square**: `polarity = ((c * (k1%2)) + (r * (k2%2))) % 2 == 0`
- **triangle**: derived from row/col and edge parity (see `triangle_grid`)
- **hexagon**: `polarity = ((r * fac) + ((c+1)/2 * fbc) + (c/2 * fab)) % 2 == 0`

The base color index is `polarity ? 0 : 1`.

### Step 8: SVG rendering

Render arcs shallowest-first. Each arc creates a closed region:

```svg
<path d="M p0 C p1 p2 p3 L [perimeter points from b back to a] Z"
      fill="colors[(base + depth + 1) % 2]" />
```

The perimeter walk: build a full perimeter array interleaving corners and EPs (corner, EP, EP, ..., corner, EP, ...). Convert EP indices `a` and `b` to full-perimeter indices, then walk backwards from `b` to `a` along the perimeter using `L` commands.

**Full perimeter construction**: for each edge in order, emit the corner vertex, then the k EP positions on that edge. The full-perimeter index of EP `a` is:

```
fi = (number of corners + EPs on edges before edge_of(a)) + 1 + position_within_edge
```

Two colors alternate by nesting depth. The outermost region of each tile gets `colors[(base + 1) % 2]`, the next nested region gets `colors[base]`, and so on.

## Coordinate transforms

All geometry above is in **unit tile space** (polygon fits roughly in [0,1]x[0,1]). To place in a grid:

```
world_x = tile.world_x + unit_x * scale
world_y = tile.world_y + unit_y * scale
```

Where `scale` is the tile size in output units (e.g. 80px) and `world_x/y` depends on grid layout:
- **square**: `(col * scale, row * scale)`
- **triangle**: `(col * scale/2, row * sqrt(3)/2 * scale)`
- **hexagon**: `(col * 0.75 * scale, row * sqrt(3)/2 * scale + offset)` with even-q stagger
