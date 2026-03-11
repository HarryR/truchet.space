"""Tile shape definitions for regular tilings.

Defines TileShape dataclass and concrete shapes for square, triangle, and
hexagon tilings. Provides utility functions for EP placement and perimeter
construction that work with any polygon.
"""

import dataclasses
import math

Point = tuple[float, float]


def lerp(a: Point, b: Point, t: float) -> Point:
    return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))


@dataclasses.dataclass
class TileShape:
    name: str
    corners: list[Point]       # polygon vertices, CCW order
    edge_normals: list[Point]  # inward-pointing normal per edge
    n_edges: int


def _compute_inward_normal(c0: Point, c1: Point,
                           centroid: Point) -> Point:
    """Compute unit inward-pointing normal for edge c0->c1."""
    dx = c1[0] - c0[0]
    dy = c1[1] - c0[1]
    # Two candidate normals: (-dy, dx) and (dy, -dx)
    nx, ny = -dy, dx
    mag = math.hypot(nx, ny)
    if mag < 1e-12:
        return (0.0, 0.0)
    nx, ny = nx / mag, ny / mag
    # Pick the one pointing toward centroid
    mid_x = (c0[0] + c1[0]) / 2
    mid_y = (c0[1] + c1[1]) / 2
    dot = nx * (centroid[0] - mid_x) + ny * (centroid[1] - mid_y)
    if dot < 0:
        nx, ny = -nx, -ny
    return (nx, ny)


def _make_shape(name: str, corners: list[Point]) -> TileShape:
    """Build a TileShape from corners, auto-computing normals."""
    n = len(corners)
    cx = sum(p[0] for p in corners) / n
    cy = sum(p[1] for p in corners) / n
    centroid = (cx, cy)
    normals:list[Point] = []
    for i in range(n):
        c0 = corners[i]
        c1 = corners[(i + 1) % n]
        normals.append(_compute_inward_normal(c0, c1, centroid))
    return TileShape(name=name, corners=corners, edge_normals=normals,
                     n_edges=n)


# --- Concrete shapes ---

SQUARE = _make_shape("square", [
    (0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)
])

# Equilateral triangle, base at bottom, normalized to unit bounding box.
# Height of equilateral triangle with base 1 = sqrt(3)/2
TRI_H = math.sqrt(3) / 2

TRIANGLE_UP = _make_shape("triangle_up", [
    (0.0, TRI_H),       # bottom-left
    (1.0, TRI_H),       # bottom-right
    (0.5, 0.0),          # top
])

TRIANGLE_DOWN = _make_shape("triangle_down", [
    (1.0, 0.0),          # top-right
    (0.0, 0.0),          # top-left
    (0.5, TRI_H),       # bottom
])

# Regular hexagon, flat-top, normalized to unit bounding box.
# Flat-top hex: width=2*r, height=sqrt(3)*r. Normalize so width=1.
_HEX_R = 0.5  # half-width
HEX_H = math.sqrt(3) * _HEX_R  # full height
_HEX_CX = 0.5
_HEX_CY = HEX_H / 2

HEXAGON = _make_shape("hexagon", [
    (_HEX_CX + _HEX_R,       _HEX_CY),                    # right
    (_HEX_CX + _HEX_R / 2,   _HEX_CY + HEX_H / 2),      # bottom-right
    (_HEX_CX - _HEX_R / 2,   _HEX_CY + HEX_H / 2),      # bottom-left
    (_HEX_CX - _HEX_R,       _HEX_CY),                    # left
    (_HEX_CX - _HEX_R / 2,   _HEX_CY - HEX_H / 2),      # top-left
    (_HEX_CX + _HEX_R / 2,   _HEX_CY - HEX_H / 2),      # top-right
])


# --- Utility functions ---

def ep_positions_for_shape(shape: TileShape,
                           edge_eps: list[int]) -> list[Point]:
    """Place EPs along edges of any polygon via lerp."""
    positions: list[Point] = []
    corners = shape.corners
    n = shape.n_edges
    for ei in range(n):
        k = edge_eps[ei]
        c0 = corners[ei]
        c1 = corners[(ei + 1) % n]
        for j in range(k):
            t = (j + 1) / (k + 1)
            positions.append(lerp(c0, c1, t))
    return positions


def ep_edge_for_shape(ep_idx: int, edge_eps: list[int]) -> int:
    """Which edge an EP belongs to (works for any n_edges)."""
    cumul = 0
    for ei, k in enumerate(edge_eps):
        if ep_idx < cumul + k:
            return ei
        cumul += k
    return len(edge_eps) - 1


def max_d_for_polygon(pos: Point, normal: Point,
                      corners: list[Point]) -> float:
    """Max d such that pos + d*normal stays inside the polygon.

    Ray-polygon intersection: for each edge, compute how far the ray
    pos + d*normal can go before crossing that edge.
    """
    d_max = float('inf')
    n = len(corners)
    nx, ny = normal

    for i in range(n):
        c0 = corners[i]
        c1 = corners[(i + 1) % n]
        # Edge direction
        ex = c1[0] - c0[0]
        ey = c1[1] - c0[1]
        # Solve: pos + d*normal = c0 + t*edge
        # (pos - c0) = t*edge - d*normal
        det = ex * ny - ey * nx
        if abs(det) < 1e-12:
            continue
        dpx = c0[0] - pos[0]
        dpy = c0[1] - pos[1]
        d_val = (ex * dpy - ey * dpx) / det
        t_val = (nx * dpy - ny * dpx) / det
        if d_val > 1e-4 and -1e-9 <= t_val <= 1 + 1e-9:
            d_max = min(d_max, d_val)

    return d_max if d_max != float('inf') else 1.0


def make_perimeter_for_shape(shape: TileShape,
                             edge_eps: list[int]
                             ) -> tuple[list[Point], list[Point]]:
    """Build full perimeter (corners + EPs) and EP-only points."""
    corners = shape.corners
    n = shape.n_edges
    full_perim: list[Point] = []
    ep_points: list[Point] = []

    for ei in range(n):
        full_perim.append(corners[ei])
        k = edge_eps[ei]
        if k > 0:
            c0 = corners[ei]
            c1 = corners[(ei + 1) % n]
            for j in range(k):
                t = (j + 1) / (k + 1)
                p = lerp(c0, c1, t)
                full_perim.append(p)
                ep_points.append(p)

    return full_perim, ep_points


def ep_to_full_index(ep_idx: int, edge_eps: list[int]) -> int:
    """Map EP index to full perimeter index."""
    cumul = 0
    for ei, k in enumerate(edge_eps):
        if ep_idx < cumul + k:
            pos = ep_idx - cumul
            fi_edge_start = sum(1 + edge_eps[e] for e in range(ei))
            return fi_edge_start + 1 + pos
        cumul += k
    return 0


def polygon_svg_points(shape: TileShape) -> str:
    """SVG polygon points string for clip paths."""
    return " ".join(f"{x:.6f},{y:.6f}" for x, y in shape.corners)
