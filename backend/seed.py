#!/usr/bin/env python3
"""
Generate a cluster of valid adjacent Truchet tiles starting from (0,0).

Respects on-chain constraints:
  - Edge EP matching: shared edge must have same EP count
  - EP sum delta <= 2 between neighbors
  - Family (ka,kb,kc,catalanIndex) uniqueness
  - EP counts in [1, 5]
  - Polarity consistency: shared edge EP parity determines whether
    neighbors must have same or opposite polarity. Placement is rejected
    if it would create a polarity conflict at the cell itself or at any
    adjacent empty cell (1-step lookahead).

Outputs tiles/ directory with {q}-{r}.json and {q}-{r}.svg for each tile,
plus tiles/grid.json listing all placed tiles.
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
from collections import deque
from typing import Any

SOLVER_BIN = os.path.join(os.path.dirname(__file__), "..", "solver", "c", "truchet")
OUT_DIR = os.path.join(os.path.dirname(__file__), "tiles")

GRID_SIZE = 512
MASK = 511

# Type aliases
TileData = dict[str, Any]
Grid = dict[tuple[int, int], TileData]
Polarity = dict[tuple[int, int], bool]
FamilySet = set[tuple[int, int, int, int]]

# ── Hex grid: even-q offset (matches TruchetNFT.sol) ──

def neighbor(q: int, r: int, edge: int) -> tuple[int, int]:
    """Even-q offset neighbor, wrapping mod 512 (torus topology)."""
    even = (q & 1) == 0
    # Use + MASK instead of - 1: (x + 511) & 511 == (x - 1) mod 512
    if edge == 0: nq, nr = q + 1,    (r if even else r + 1)
    elif edge == 1: nq, nr = q,      r + 1
    elif edge == 2: nq, nr = q + MASK, (r if even else r + 1)
    elif edge == 3: nq, nr = q + MASK, (r + MASK if even else r)
    elif edge == 4: nq, nr = q,      r + MASK
    elif edge == 5: nq, nr = q + 1,  (r + MASK if even else r)
    else: raise ValueError(f"invalid edge: {edge}")
    return (nq & MASK, nr & MASK)

def facing_edge(edge: int) -> int:
    return (edge + 3) % 6

def edge_param(edge: int) -> int:
    """Edge index -> which of (ka=0, kb=1, kc=2) it maps to."""
    return edge % 3

# ── Catalan numbers (for valid idx range) ──

def catalan(n: int) -> int:
    """C(n) = binomial(2n, n) / (n+1)."""
    if n <= 0:
        return 1
    c = 1
    for i in range(n):
        c = c * (2 * n - i) // (i + 1)
    return c // (n + 1)

def max_catalan_index(ka: int, kb: int, kc: int) -> int:
    """Number of valid non-crossing matchings for this family."""
    total_eps = 2 * (ka + kb + kc)
    return catalan(total_eps // 2)

# ── Polarity rules ──

def required_polarity(q: int, r: int, grid: Grid, polarity: Polarity) -> tuple[bool | None, bool]:
    """Determine what polarity cell (q,r) must have based on placed neighbors.

    Returns (required_polarity, conflict). If conflict is True, neighbors disagree.
    If required_polarity is None, no placed neighbors constrain us.
    """
    required: bool | None = None
    for edge in range(6):
        nq, nr = neighbor(q, r, edge)
        if (nq, nr) not in grid:
            continue
        nb = grid[(nq, nr)]
        nb_pol = polarity[(nq, nr)]
        # Shared EP count: neighbor's EP on its facing edge
        nb_param_idx = edge_param(facing_edge(edge))
        shared_k: int = [nb["ka"], nb["kb"], nb["kc"]][nb_param_idx]
        # Odd → flip, even → same
        need = nb_pol if shared_k % 2 == 0 else not nb_pol
        if required is None:
            required = need
        elif required != need:
            return None, True  # conflict
    return required, False


def check_lookahead(q: int, r: int, tile: TileData, tile_pol: bool,
                    grid: Grid, polarity: Polarity) -> bool:
    """Check that placing tile at (q,r) with tile_pol doesn't make any
    adjacent empty cell unplaceable.

    For each empty neighbor E of (q,r), pretend (q,r) is placed and check
    if all of E's placed neighbors (including the new tile) agree on E's
    required polarity.
    """
    eps: list[int] = [tile["ka"], tile["kb"], tile["kc"]]
    for edge in range(6):
        eq, er = neighbor(q, r, edge)
        if (eq, er) in grid:
            continue  # not empty, skip
        # E is empty — check what polarity it would need
        # First, constraint from the tile we're about to place
        our_param_idx = edge_param(edge)
        shared_k_from_us = eps[our_param_idx]
        e_required = tile_pol if shared_k_from_us % 2 == 0 else not tile_pol
        # Now check E's other placed neighbors
        for e_edge in range(6):
            enq, enr = neighbor(eq, er, e_edge)
            if (enq, enr) == (q, r):
                continue  # that's us, already accounted for
            if (enq, enr) not in grid:
                continue
            nb = grid[(enq, enr)]
            nb_pol = polarity[(enq, enr)]
            nb_param_idx = edge_param(facing_edge(e_edge))
            shared_k: int = [nb["ka"], nb["kb"], nb["kc"]][nb_param_idx]
            need = nb_pol if shared_k % 2 == 0 else not nb_pol
            if need != e_required:
                return False  # conflict — would make E unplaceable
    return True


# ── Tile generation ──

def pick_tile(q: int, r: int, grid: Grid, polarity: Polarity,
              used_families: FamilySet) -> tuple[TileData, bool] | None:
    """
    Pick valid (ka, kb, kc, catalanIndex) for cell (q, r) given existing grid.
    Returns (tile_dict, polarity) or None if no valid tile found.
    """
    # Gather EP constraints from neighbors
    constrained: dict[int, int] = {}  # param_index -> required EP count
    neighbor_sums: list[int] = []

    for edge in range(6):
        nq, nr = neighbor(q, r, edge)
        nb = grid.get((nq, nr))
        if nb is None:
            continue
        param_idx = edge_param(edge)
        nb_param_idx = edge_param(facing_edge(edge))
        nb_eps: list[int] = [nb["ka"], nb["kb"], nb["kc"]]
        required = nb_eps[nb_param_idx]

        if param_idx in constrained and constrained[param_idx] != required:
            return None  # conflicting EP constraints
        constrained[param_idx] = required
        neighbor_sums.append(nb["ka"] + nb["kb"] + nb["kc"])

    # Pick values for unconstrained params
    eps = [0, 0, 0]
    for i in range(3):
        if i in constrained:
            eps[i] = constrained[i]
        else:
            eps[i] = random.randint(1, 4)

    ka, kb, kc = eps
    our_sum = ka + kb + kc

    # Check EP sum delta <= 2 against all neighbors
    for ns in neighbor_sums:
        if abs(our_sum - ns) > 2:
            return None

    # Reject if any EP is 0
    if ka == 0 or kb == 0 or kc == 0:
        return None

    tile: TileData = {"ka": ka, "kb": kb, "kc": kc}

    # Rule 1: self-consistency — determine polarity from placed neighbors
    pol, conflict = required_polarity(q, r, grid, polarity)
    if conflict:
        return None
    if pol is None:
        pol = True  # no placed neighbors, free choice

    # Rule 2: lookahead — would this make any adjacent empty cell unplaceable?
    if not check_lookahead(q, r, tile, pol, grid, polarity):
        return None

    # Pick a random Catalan index
    max_idx = max_catalan_index(ka, kb, kc)
    if max_idx == 0:
        return None

    for _ in range(min(max_idx, 20)):
        idx = random.randint(0, max_idx - 1)
        family_key = (ka, kb, kc, idx)
        if family_key not in used_families:
            used_families.add(family_key)
            tile["catalanIndex"] = idx
            return tile, pol

    return None


def generate_cluster(n_tiles: int = 200, max_attempts: int = 2000) -> tuple[Grid, Polarity]:
    """BFS outward from (0,0), placing valid tiles.

    Returns (grid, polarity) where both are keyed by (q, r).
    """
    grid: Grid = {}
    polarity: Polarity = {}
    used_families: FamilySet = set()

    # Seed tile at (0,0)
    seed: TileData = {"ka": 2, "kb": 1, "kc": 1, "catalanIndex": 0}
    grid[(0, 0)] = seed
    polarity[(0, 0)] = True
    used_families.add((2, 1, 1, 0))

    # BFS frontier
    frontier: deque[tuple[int, int]] = deque()
    for edge in range(6):
        frontier.append(neighbor(0, 0, edge))

    attempts = 0
    while len(grid) < n_tiles and frontier and attempts < max_attempts:
        q, r = frontier.popleft()
        if (q, r) in grid:
            continue
        attempts += 1
        # Try multiple times to find a valid tile
        result = None
        for _ in range(10):
            result = pick_tile(q, r, grid, polarity, used_families)
            if result:
                break

        if result is None:
            continue

        tile, pol = result
        grid[(q, r)] = tile
        polarity[(q, r)] = pol
        attempts = 0  # reset on success

        # Add new frontier cells
        for edge in range(6):
            nq, nr = neighbor(q, r, edge)
            if (nq, nr) not in grid:
                frontier.append((nq, nr))

    return grid, polarity


def solve_tile(ka: int, kb: int, kc: int, idx: int, pol: bool = True) -> str:
    """Run C solver, return SVG string."""
    cmd = [
        SOLVER_BIN,
        "shape=hex",
        f"eps={ka},{kb},{kc}",
        f"idx={idx}",
        f"polarity={1 if pol else 0}",
        "w=1", "h=1",
        "svg=-",
        "-q",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Solver failed for ({ka},{kb},{kc}) idx={idx}: {result.stderr.strip()}")
    return result.stdout


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    print(f"Generating cluster of ~{n} tiles...")

    grid, polarity = generate_cluster(n_tiles=n)
    os.makedirs(OUT_DIR, exist_ok=True)

    # Write grid index
    grid_index: list[TileData] = []
    for (q, r), tile in sorted(grid.items()):
        p = polarity[(q, r)]
        entry: TileData = {"q": q, "r": r, **tile, "polarity": int(p)}
        grid_index.append(entry)
        print(f"  ({q:2d}, {r:2d})  ka={tile['ka']} kb={tile['kb']} kc={tile['kc']} idx={tile['catalanIndex']} pol={int(p)}")

    with open(os.path.join(OUT_DIR, "grid.json"), "w") as f:
        json.dump(grid_index, f, indent=2)

    # Solve each tile
    for (q, r), tile in sorted(grid.items()):
        p = polarity[(q, r)]
        svg = solve_tile(tile["ka"], tile["kb"], tile["kc"], tile["catalanIndex"], p)
        svg_path = os.path.join(OUT_DIR, f"{q}-{r}.svg")
        with open(svg_path, "w") as f:
            f.write(svg)

    print(f"\n{len(grid)} tiles written to {OUT_DIR}/")
    print(f"  grid.json + {len(grid)} SVG files")


if __name__ == "__main__":
    main()
