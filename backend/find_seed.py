"""
Generate a valid dense NxM hex seed grid by calling the C solver.

The solver generates a complete grid with a single EP configuration,
assigning valid Catalan indices for each tile. No constraint reimplementation.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass

SOLVER_BIN = os.path.join(os.path.dirname(__file__), "..", "solver", "c", "truchet")


@dataclass
class SeedTile:
    q: int
    r: int
    ka: int
    kb: int
    kc: int
    polarity: bool
    catalan_index: int


@dataclass
class SeedGrid:
    q0: int
    r0: int
    width: int
    height: int
    tiles: list[SeedTile]  # column-major order

    @property
    def kas(self) -> list[int]:
        return [t.ka for t in self.tiles]

    @property
    def kbs(self) -> list[int]:
        return [t.kb for t in self.tiles]

    @property
    def kcs(self) -> list[int]:
        return [t.kc for t in self.tiles]

    @property
    def catalan_indexes(self) -> list[int]:
        return [t.catalan_index for t in self.tiles]

    @property
    def polarities(self) -> int:
        bits = 0
        for i, t in enumerate(self.tiles):
            if t.polarity:
                bits |= 1 << i
        return bits


def find_seed(q0: int, r0: int, width: int, height: int,
              ka: int = 2, kb: int = 2, kc: int = 2) -> SeedGrid:
    """Generate a seed grid by running the C solver.

    Retries with different RNG seeds until all Catalan indices are unique
    (required by the contract's family uniqueness constraint).
    """
    n = width * height
    tile_grid: dict[tuple[int, int], int] = {}

    for seed in range(1000):
        cmd = [
            SOLVER_BIN,
            "shape=hex",
            f"eps={ka},{kb},{kc}",
            f"w={width}", f"h={height}",
            f"pos={q0},{r0}",
            f"seed={seed}",
            "json=-", "-q",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            continue

        data = json.loads(result.stdout)
        tile_grid.clear()
        polarity_map: dict[tuple[int, int], bool] = {}
        seen: set[int] = set()
        unique = True
        for i, tile_data in enumerate(data["tiles"]):
            col = i % width
            row = i // width
            catalan_idx = int(tile_data[0])
            polarity = bool(tile_data[1])
            if catalan_idx in seen:
                unique = False
                break
            seen.add(catalan_idx)
            tile_grid[(col, row)] = catalan_idx
            polarity_map[(col, row)] = polarity

        if unique:
            break
    else:
        raise RuntimeError(f"Could not find {n} unique Catalan indices after 1000 attempts")

    # Build column-major tile list — polarity comes from the solver
    tiles: list[SeedTile] = []
    for col in range(width):
        for row in range(height):
            q = (q0 + col) & 0x1FF
            r = (r0 + row) & 0x1FF
            tiles.append(SeedTile(
                q=q, r=r, ka=ka, kb=kb, kc=kc,
                polarity=polarity_map[(col, row)],
                catalan_index=tile_grid[(col, row)],
            ))

    return SeedGrid(q0=q0, r0=r0, width=width, height=height, tiles=tiles)


if __name__ == "__main__":
    from math import comb

    def catalan(n: int) -> int:
        return comb(2 * n, n) // (n + 1)

    grid = find_seed(0, 0, 5, 5)
    print(f"Seed: {grid.width}x{grid.height} at ({grid.q0},{grid.r0})")
    print(f"Family: ({grid.tiles[0].ka},{grid.tiles[0].kb},{grid.tiles[0].kc})")
    n = grid.tiles[0].ka + grid.tiles[0].kb + grid.tiles[0].kc
    print(f"Catalan({n}) = {catalan(n)}, using {len(grid.tiles)} tiles")
    print(f"Polarities: {grid.polarities}")
    print(f"\nTiles (column-major):")
    for i, t in enumerate(grid.tiles):
        pol = "+" if t.polarity else "-"
        print(f"  i={i:2d} ({t.q},{t.r}) idx={t.catalan_index} pol={pol}")
