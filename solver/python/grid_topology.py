"""Grid topology for regular tilings.

Handles tile placement, neighbor edge matching, polarity (2-coloring),
and tile descriptor generation for square, triangle, and hexagon grids.
"""

import dataclasses

from tile_shapes import (
    TileShape, SQUARE, TRIANGLE_UP, TRIANGLE_DOWN, HEXAGON, TRI_H, HEX_H
)


@dataclasses.dataclass
class TileDescriptor:
    """Everything needed to solve and render one tile."""
    row: int
    col: int
    shape: TileShape
    edge_eps: list[int]
    polarity: bool
    world_x: float
    world_y: float
    scale: float


# ---------------------------------------------------------------------------
# Square grid
# ---------------------------------------------------------------------------

def square_grid(rows: int, cols: int, k1: int, k2: int,
                scale: float = 1.0) -> list[TileDescriptor]:
    """Square tiling with edge config [k1, k2, k1, k2].

    k1 = horizontal edges (top/bottom), k2 = vertical edges (right/left).
    Polarity: flips = c*(k1%2) + r*(k2%2), polarity = (flips%2)==0
    """
    edge_eps = [k1, k2, k1, k2]
    tiles:list[TileDescriptor] = []
    for r in range(rows):
        for c in range(cols):
            flips = c * (k1 % 2) + r * (k2 % 2)
            polarity = (flips % 2) == 0
            tiles.append(TileDescriptor(
                row=r, col=c, shape=SQUARE, edge_eps=edge_eps,
                polarity=polarity,
                world_x=c * scale, world_y=r * scale,
                scale=scale,
            ))
    return tiles


# ---------------------------------------------------------------------------
# Triangle grid
# ---------------------------------------------------------------------------

def triangle_grid(rows: int, cols: int, k0: int, k1: int, k2: int,
                  scale: float = 1.0) -> list[TileDescriptor]:
    """Triangular tiling with alternating up/down triangles.

    Row r, col c: is_up = ((r+c)%2 == 0).
    Each row has `cols` triangles.

    Edge EPs: [k0, k1, k2] for both up and down shapes.
    Up edges: 0=bottom (BL->BR), 1=right (BR->Top), 2=left (Top->BL)
    Down edges: 0=top (TR->TL), 1=left (TL->Bot), 2=right (Bot->TR)

    Shared edges (same-index pairing):
      U→D horizontally: edge 1 (flip k1%2)
      D→U horizontally: edge 2 (flip k2%2)
      U→D vertically:   edge 0 (flip k0%2)

    Polarity propagation from (0,0):
      Cross-row adds k0%2 per row.
      Within a row, alternates k1%2 and k2%2 flips.
    """
    tiles:list[TileDescriptor] = []
    half_w = 0.5 * scale
    f0, f1, f2 = k0 % 2, k1 % 2, k2 % 2

    for r in range(rows):
        for c in range(cols):
            is_up = ((r + c) % 2 == 0)
            shape = TRIANGLE_UP if is_up else TRIANGLE_DOWN

            wx = c * half_w
            wy = r * TRI_H * scale

            edge_eps = [k0, k1, k2]

            # Polarity: propagate from (0,0)=True.
            # Within a row, U→D flips by f1, D→U flips by f2.
            # Cross-row: even→odd row uses edge 0 (flip f0).
            # Odd→even row has no direct edge 0 connection at col 0;
            # the 3-hop detour flips by f0+f1+f2 = 0 (total is even).
            # So cumulative row flip = ceil(r/2) * f0.
            row_flip = ((r + 1) // 2) * f0
            if r % 2 == 0:
                flip = (row_flip
                        + ((c + 1) // 2) * f1
                        + (c // 2) * f2) % 2
            else:
                flip = (row_flip
                        + ((c + 1) // 2) * f2
                        + (c // 2) * f1) % 2
            polarity = (flip == 0)

            tiles.append(TileDescriptor(
                row=r, col=c, shape=shape, edge_eps=edge_eps,
                polarity=polarity,
                world_x=wx, world_y=wy,
                scale=scale,
            ))
    return tiles


# ---------------------------------------------------------------------------
# Hexagon grid
# ---------------------------------------------------------------------------

def hexagon_grid(rows: int, cols: int, ka: int, kb: int, kc: int,
                 scale: float = 1.0) -> list[TileDescriptor]:
    """Hexagonal tiling with offset-row (even-q) layout.

    Edge EPs: [ka, kb, kc, ka, kb, kc] — opposite edge pairs match.
    Hex edges (flat-top, CCW from right):
      0: right→bottom-right, 1: bottom-right→bottom-left, 2: bottom-left→left,
      3: left→top-left, 4: top-left→top-right, 5: top-right→right

    Neighbor sharing (edge i ↔ neighbor's edge i+3):
      edge 0↔3: flip (kb+kc)%2
      edge 1↔4: flip (ka+kc)%2
      edge 2↔5: flip (ka+kb)%2

    Even-q neighbor map:
      Even col: edge 0→(r,c+1), edge 1→(r+1,c), edge 5→(r-1,c+1)
      Odd col:  edge 0→(r+1,c+1), edge 1→(r+1,c), edge 5→(r,c+1)

    Polarity propagation from (0,0):
      Within row: even→odd via edge 0 (flip fbc), odd→even via edge 5 (flip fab)
      Cross-row: via edge 1 (flip fac)
    """
    edge_eps = [ka, kb, kc, ka, kb, kc]
    tiles:list[TileDescriptor] = []

    hex_w = scale
    col_spacing = 0.75 * hex_w
    row_spacing = HEX_H * scale

    fab = (ka + kb) % 2  # edge 2↔5 flip
    fac = (ka + kc) % 2  # edge 1↔4 flip
    fbc = (kb + kc) % 2  # edge 0↔3 flip

    for r in range(rows):
        for c in range(cols):
            wx = c * col_spacing
            wy = r * row_spacing
            if c % 2 == 1:
                wy += row_spacing / 2

            # Polarity: propagate from (0,0)=True.
            # Within row: alternating fbc, fab flips.
            # Cross-row: fac per row.
            flip = (r * fac
                    + ((c + 1) // 2) * fbc
                    + (c // 2) * fab) % 2
            polarity = (flip == 0)

            tiles.append(TileDescriptor(
                row=r, col=c, shape=HEXAGON, edge_eps=edge_eps,
                polarity=polarity,
                world_x=wx, world_y=wy,
                scale=scale,
            ))
    return tiles
