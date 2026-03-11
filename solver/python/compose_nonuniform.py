#!/usr/bin/env python3
"""Compose a grid of Truchet tiles on regular tilings.

Supports square (default), triangle, and hexagon grids.

Usage:
    python compose_nonuniform.py [rows] [cols] [total_eps] [seed] [--shape square|triangle|hexagon] [--curves] [--grid]

    total_eps must be even. Split into edge EP counts is chosen randomly.
"""

import os
import sys
import random
import time

sys.path.insert(0, os.path.dirname(__file__))
from tile_bez_bitbash import solve_tile_general, warmup_jit
from tile_shapes import (ep_edge_for_shape, ep_to_full_index,
    make_perimeter_for_shape,
)
from grid_topology import (
    TileDescriptor, square_grid, triangle_grid, hexagon_grid,
)

Point = tuple[float, float]
Segment = tuple[Point, Point, Point, Point]


def lerp(a: Point, b: Point, t: float) -> Point:
    return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))


# ---------------------------------------------------------------------------
# Non-crossing perfect matchings (direct sampling)
# ---------------------------------------------------------------------------

def catalan(n: int) -> int:
    if n <= 0:
        return 1
    c = 1
    for i in range(n):
        c = c * 2 * (2 * i + 1) // (i + 2)
    return c


def random_non_crossing_matching(n: int, rng: random.Random
                                 ) -> list[tuple[int, int]]:
    """Sample a uniformly random non-crossing perfect matching of 0..n-1."""
    def _sample(pts: list[int]) -> list[tuple[int, int]]:
        if len(pts) == 0:
            return []
        first = pts[0]
        choices: list[tuple[int, int]] = []
        for k in range(1, len(pts), 2):
            n_inside = (k - 1) // 2
            n_outside = (len(pts) - k - 1) // 2
            w = catalan(n_inside) * catalan(n_outside)
            choices.append((k, w))
        total = sum(w for _, w in choices)
        r = rng.random() * total
        cumul = 0
        chosen_k = choices[-1][0]
        for k, w in choices:
            cumul += w
            if r < cumul:
                chosen_k = k
                break
        partner = pts[chosen_k]
        inside = pts[1:chosen_k]
        outside = pts[chosen_k + 1:]
        return ([(first, partner)]
                + _sample(inside)
                + _sample(outside))

    return _sample(list(range(n)))


# ---------------------------------------------------------------------------
# Type aliases
# ---------------------------------------------------------------------------

EdgeEps = list[int]
Matching = list[tuple[int, int]]
SolvedCurves = dict[int, list[Segment]]


# ---------------------------------------------------------------------------
# Nesting tree
# ---------------------------------------------------------------------------

def nesting_tree(matching: Matching, n_points: int
                 ) -> tuple[list[int], list[tuple[int, int]]]:
    pairs = [(min(a, b), max(a, b)) for a, b in matching]
    n = len(pairs)
    parent = [-1] * n
    for i in range(n):
        ai, bi = pairs[i]
        best, best_size = -1, n_points + 1
        for j in range(n):
            if i == j:
                continue
            aj, bj = pairs[j]
            if aj < ai and bi < bj and (bj - aj) < best_size:
                best_size = bj - aj
                best = j
        parent[i] = best
    return parent, pairs


def nesting_depth(parent: list[int]) -> list[int]:
    depths = [0] * len(parent)
    for i in range(len(parent)):
        d, p = 0, i
        while parent[p] != -1:
            d += 1
            p = parent[p]
        depths[i] = d
    return depths


# ---------------------------------------------------------------------------
# Region path (shape-generic)
# ---------------------------------------------------------------------------

def _wp(x: float, y: float, tx: float, ty: float, sc: float) -> str:
    """Format a point in world coordinates."""
    return f"{tx + x * sc:.4f},{ty + y * sc:.4f}"


def region_path_d_resolved(a: int, b: int, edge_eps: EdgeEps,
                           full_perim: list[Point],
                           segments: list[Segment],
                           tx: float = 0.0, ty: float = 0.0,
                           sc: float = 1.0) -> str:
    """SVG path data using pre-resolved bezier segments, in world coords."""
    seg0 = segments[0]
    parts = [f"M {_wp(seg0[0][0], seg0[0][1], tx, ty, sc)}"]
    for seg in segments:
        parts.append(f"C {_wp(seg[1][0], seg[1][1], tx, ty, sc)} "
                     f"{_wp(seg[2][0], seg[2][1], tx, ty, sc)} "
                     f"{_wp(seg[3][0], seg[3][1], tx, ty, sc)}")

    fi_a = ep_to_full_index(a, edge_eps)
    fi_b = ep_to_full_index(b, edge_eps)
    for fi in range(fi_b - 1, fi_a, -1):
        p = full_perim[fi]
        parts.append(f"L {_wp(p[0], p[1], tx, ty, sc)}")

    parts.append("Z")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Grid assignment (shape-generic)
# ---------------------------------------------------------------------------

def valid_splits_square(total: int) -> list[tuple[int, int]]:
    """All (k1, k2) pairs where 2*(k1+k2) == total and k1,k2 >= 0."""
    half = total // 2
    return [(k1, half - k1) for k1 in range(half + 1)]


def valid_splits_triangle(total: int) -> list[tuple[int, int, int]]:
    """All (k0, k1, k2) triples where k0+k1+k2 == total and total is even."""
    results:list[tuple[int,int,int]] = []
    for k0 in range(total + 1):
        for k1 in range(total - k0 + 1):
            k2 = total - k0 - k1
            results.append((k0, k1, k2))
    return results


def valid_splits_hexagon(total: int) -> list[tuple[int, int, int]]:
    """All (ka, kb, kc) triples where 2*(ka+kb+kc) == total."""
    half = total // 2
    results:list[tuple[int,int,int]] = []
    for ka in range(half + 1):
        for kb in range(half - ka + 1):
            kc = half - ka - kb
            results.append((ka, kb, kc))
    return results


MAX_MATCHING_RETRIES = 20


def solve_tile_for_descriptor(desc: TileDescriptor,
                              rng: random.Random,
                              verbose: bool = True
                              ) -> tuple[Matching, SolvedCurves]:
    """Solve a single tile: generate matching and find non-overlapping curves."""
    shape = desc.shape
    edge_eps = desc.edge_eps
    n_points = sum(edge_eps)

    if n_points == 0:
        return [], {}

    full_perim, ep_points = make_perimeter_for_shape(shape, edge_eps)
    edge_list = [ep_edge_for_shape(i, edge_eps) for i in range(n_points)]

    for retry in range(MAX_MATCHING_RETRIES):
        matching = random_non_crossing_matching(n_points, rng)
        parent, pairs = nesting_tree(matching, n_points)

        try:
            arc_results = solve_tile_general(
                pairs, ep_points, edge_list, verbose=False,
                edge_normals=shape.edge_normals,
                polygon_corners=shape.corners)
        except RuntimeError:
            if verbose:
                print(f"  tile ({desc.row},{desc.col}) retry {retry+1}: "
                      f"matching failed, re-rolling...")
            continue

        curves: SolvedCurves = {}
        for ci, (p0, p1, p2, p3, _d0, _d1) in enumerate(arc_results):
            curves[ci] = [(p0, p1, p2, p3)]
        return matching, curves

    raise RuntimeError(
        f"Tile ({desc.row},{desc.col}): no solvable matching after "
        f"{MAX_MATCHING_RETRIES} attempts")


# ---------------------------------------------------------------------------
# SVG rendering (shape-generic)
# ---------------------------------------------------------------------------

SolvedTile = tuple[TileDescriptor, Matching, SolvedCurves]


def compute_svg_bounds(tiles: list[SolvedTile],
                       margin: float = 4.0
                       ) -> tuple[float, float, float, float]:
    """Compute (min_x, min_y, total_w, total_h) for all tiles."""
    if not tiles:
        return (0, 0, 100, 100)

    min_x = float('inf')
    min_y = float('inf')
    max_x = float('-inf')
    max_y = float('-inf')

    for desc, _, _ in tiles:
        shape = desc.shape
        sc = desc.scale
        for cx, cy in shape.corners:
            wx = desc.world_x + cx * sc
            wy = desc.world_y + cy * sc
            min_x = min(min_x, wx)
            min_y = min(min_y, wy)
            max_x = max(max_x, wx)
            max_y = max(max_y, wy)

    return (min_x - margin, min_y - margin,
            max_x - min_x + 2 * margin,
            max_y - min_y + 2 * margin)


def render_svg(tiles: list[SolvedTile],
               path: str,
               tile_scale: float = 80.0,
               margin: float = 4.0,
               colors: tuple[str, str] = ("#2c3e50", "#ecf0f1"),
               show_outlines: bool = False,
               show_curves: bool = False):
    """Render all tiles as SVG with filled regions."""
    vx, vy, vw, vh = compute_svg_bounds(tiles, margin)

    lines: list[str] = []
    lines.append('<?xml version="1.0" encoding="UTF-8"?>')
    lines.append(f'<svg xmlns="http://www.w3.org/2000/svg" '
                 f'width="{vw:.0f}" height="{vh:.0f}" '
                 f'viewBox="{vx:.1f} {vy:.1f} {vw:.1f} {vh:.1f}" '
                 f'shape-rendering="crispEdges">')
    lines.append(f'<rect x="{vx:.1f}" y="{vy:.1f}" '
                 f'width="{vw:.1f}" height="{vh:.1f}" fill="{colors[1]}"/>')

    # Background pass: merge all same-colored tile backgrounds into
    # single paths to eliminate anti-aliasing seams between adjacent tiles.
    for color_idx in range(2):
        bg_parts: list[str] = []
        for desc, _, _ in tiles:
            base = 0 if desc.polarity else 1
            if base != color_idx:
                continue
            sc = desc.scale
            tx = desc.world_x
            ty = desc.world_y
            corners = desc.shape.corners
            first = corners[0]
            bg_parts.append(f"M {tx + first[0]*sc:.4f},{ty + first[1]*sc:.4f}")
            for cx, cy in corners[1:]:
                bg_parts.append(f"L {tx + cx*sc:.4f},{ty + cy*sc:.4f}")
            bg_parts.append("Z")
        if bg_parts:
            lines.append(f'<path d="{" ".join(bg_parts)}" '
                         f'fill="{colors[color_idx]}" stroke="none"/>')

    for desc, matching, resolved in tiles:
        shape = desc.shape
        edge_eps = desc.edge_eps
        n_points = sum(edge_eps)
        sc = desc.scale
        tx = desc.world_x
        ty = desc.world_y

        base = 0 if desc.polarity else 1

        if n_points == 0:
            continue

        full_perim, _ = make_perimeter_for_shape(shape, edge_eps)
        parent, pairs = nesting_tree(matching, n_points)
        depths = nesting_depth(parent)

        curve_order = sorted(range(len(pairs)), key=lambda i: depths[i])
        for ci in curve_order:
            a, b = pairs[ci]
            depth = depths[ci]
            fill_idx = (base + depth + 1) % 2
            d = region_path_d_resolved(a, b, edge_eps, full_perim,
                                       resolved[ci], tx, ty, sc)
            lines.append(f'<path d="{d}" fill="{colors[fill_idx]}" '
                         f'stroke="none"/>')

        if show_curves:
            for ci, (a, b) in enumerate(pairs):
                segs = resolved[ci]
                for seg in segs:
                    lines.append(
                        f'<path d="M {_wp(seg[0][0], seg[0][1], tx, ty, sc)} '
                        f'C {_wp(seg[1][0], seg[1][1], tx, ty, sc)} '
                        f'{_wp(seg[2][0], seg[2][1], tx, ty, sc)} '
                        f'{_wp(seg[3][0], seg[3][1], tx, ty, sc)}" '
                        f'fill="none" stroke="#fff3" '
                        f'stroke-width="{0.008 * sc:.4f}"/>')

    if show_outlines:
        for desc, _, _ in tiles:
            sc = desc.scale
            tx = desc.world_x
            ty = desc.world_y
            pts_str = " ".join(
                f"{tx + x * sc:.4f},{ty + y * sc:.4f}"
                for x, y in desc.shape.corners)
            lines.append(
                f'<polygon points="{pts_str}" '
                f'fill="none" stroke="#0001" stroke-width="0.5"/>')

    lines.append('</svg>')

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as f:
        f.write("\n".join(lines))
    print(f"  wrote {path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    show_curves = "--curves" in sys.argv
    show_outlines = "--grid" in sys.argv

    # Parse --shape argument
    tile_shape = "square"
    for i, a in enumerate(sys.argv[1:], 1):
        if a == "--shape" and i + 1 < len(sys.argv):
            tile_shape = sys.argv[i + 1]

    args = [a for a in sys.argv[1:]
            if not a.startswith("--") and
            (sys.argv[sys.argv.index(a) - 1] != "--shape"
             if a in sys.argv and sys.argv.index(a) > 0 else True)]
    # Simpler re-parse: just grab positional args
    positional:list[str] = []
    skip_next = False
    for a in sys.argv[1:]:
        if skip_next:
            skip_next = False
            continue
        if a == "--shape":
            skip_next = True
            continue
        if a.startswith("--"):
            continue
        positional.append(a)
    args = positional

    rows = int(args[0]) if len(args) > 0 else 6
    cols = int(args[1]) if len(args) > 1 else 6
    total_eps = int(args[2]) if len(args) > 2 else 4
    seed = int(args[3]) if len(args) > 3 else None

    if total_eps % 2 != 0:
        print(f"total_eps={total_eps} is odd — must be even for 2-colorability.")
        print(f"Try {total_eps - 1} or {total_eps + 1}.")
        sys.exit(1)

    rng = random.Random(seed)
    tile_scale = 80.0

    if tile_shape == "square":
        splits = valid_splits_square(total_eps)
        interesting = [(k1, k2) for k1, k2 in splits if k1 > 0 and k2 > 0]
        if not interesting:
            interesting = splits
        weights = [min(k1, k2) + 1 for k1, k2 in interesting]
        k1, k2 = rng.choices(interesting, weights=weights, k=1)[0]

        print(f"Grid: {rows}x{cols} squares, {total_eps} EPs/tile")
        print(f"  split: k1={k1} (horiz), k2={k2} (vert)")
        print(f"  edge config: [{k1}, {k2}, {k1}, {k2}]")

        descriptors = square_grid(rows, cols, k1, k2, tile_scale)
        out_name = f"compose_square_{k1}_{k2}.svg"

    elif tile_shape == "triangle":
        splits = valid_splits_triangle(total_eps)
        interesting = [(a, b, c) for a, b, c in splits
                       if a > 0 and b > 0 and c > 0]
        if not interesting:
            interesting = [(a, b, c) for a, b, c in splits
                           if a + b + c > 0]
        if not interesting:
            interesting = splits
        weights = [(min(a, b, c) + 1) ** 3 for a, b, c in interesting]
        k0, k1, k2 = rng.choices(interesting, weights=weights, k=1)[0]

        print(f"Grid: {rows}x{cols} triangles, {total_eps} EPs/tile")
        print(f"  split: k0={k0}, k1={k1}, k2={k2}")

        descriptors = triangle_grid(rows, cols, k0, k1, k2, tile_scale)
        out_name = f"compose_triangle_{k0}_{k1}_{k2}.svg"

    elif tile_shape == "hexagon":
        splits = valid_splits_hexagon(total_eps)
        interesting = [(a, b, c) for a, b, c in splits
                       if a > 0 and b > 0 and c > 0]
        if not interesting:
            interesting = [(a, b, c) for a, b, c in splits
                           if a + b + c > 0]
        if not interesting:
            interesting = splits
        weights = [(min(a, b, c) + 1) ** 3 for a, b, c in interesting]
        ka, kb, kc = rng.choices(interesting, weights=weights, k=1)[0]

        print(f"Grid: {rows}x{cols} hexagons, {total_eps} EPs/tile")
        print(f"  split: ka={ka}, kb={kb}, kc={kc}")
        print(f"  edge config: [{ka}, {kb}, {kc}, {ka}, {kb}, {kc}]")

        descriptors = hexagon_grid(rows, cols, ka, kb, kc, tile_scale)
        out_name = f"compose_hexagon_{ka}_{kb}_{kc}.svg"

    else:
        print(f"Unknown shape: {tile_shape}. Use square, triangle, or hexagon.")
        sys.exit(1)

    n_matchings = catalan(total_eps // 2)
    print(f"  C({total_eps // 2}) = {n_matchings} matchings")

    # JIT warmup
    print("Compiling JIT kernels...", end=" ", flush=True)
    t0 = time.perf_counter()
    warmup_jit()
    print(f"{time.perf_counter() - t0:.2f}s")

    # Solve all tiles
    print(f"Solving {len(descriptors)} tiles...")
    solved_tiles: list[SolvedTile] = []
    for desc in descriptors:
        matching, curves = solve_tile_for_descriptor(desc, rng)
        solved_tiles.append((desc, matching, curves))

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), out_name)
    render_svg(solved_tiles, out, tile_scale,
               show_outlines=show_outlines, show_curves=show_curves)

    # Stats
    n_tiles = len(solved_tiles)
    n_pol_true = sum(1 for d, _, _ in solved_tiles if d.polarity)
    n_pol_false = n_tiles - n_pol_true

    # Canonicalize matchings: sort each pair, then sort the list
    def canon(m: Matching) -> tuple:
        return tuple(sorted((min(a, b), max(a, b)) for a, b in m))

    distinct_matchings = set()
    distinct_tiles = set()  # (matching, polarity)
    for desc, matching, _ in solved_tiles:
        cm = canon(matching)
        distinct_matchings.add(cm)
        distinct_tiles.add((cm, desc.polarity))

    print(f"\nStats:")
    print(f"  Grid: {n_tiles} tiles ({n_pol_true} polarity+, "
          f"{n_pol_false} polarity-)")
    print(f"  Possible matchings: C({total_eps // 2}) = {n_matchings}")
    print(f"  Possible tile types: {2 * n_matchings} "
          f"({n_matchings} matchings x 2 polarities)")
    print(f"  Distinct matchings used: {len(distinct_matchings)}/{n_matchings}")
    print(f"  Distinct tile types used: {len(distinct_tiles)}/{2 * n_matchings}")
    if n_matchings > 0:
        coverage = len(distinct_matchings) / n_matchings * 100
        print(f"  Matching space coverage: {coverage:.2f}%")
    print("Done.")


if __name__ == "__main__":
    main()
