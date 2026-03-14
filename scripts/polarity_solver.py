#!/usr/bin/env python3
"""
Polarity solver: simulates arc region coloring for hex Truchet tiles.

Geometry:
  Arcs partition the hexagon into regions. Adjacent regions within a tile
  have opposite colors (alternating by nesting depth). Polarity sets the
  outermost region's color. Across a shared edge, regions touching the
  same segment must have the SAME color.

Modes:
  pair      Single-edge formula validation (original test).
  neighbor  Multi-neighbor placement test: generates a consistent ring of
            2-6 neighbors, then checks if a center tile can be placed and
            whether the per-edge formula gives consistent polarity.

Usage:
    python -mbackend.polarity_solver pair [n_samples] [max_k]
    python -mbackend.polarity_solver neighbor [n_samples] [max_k]
"""
import random
import sys


# ── Types ──────────────────────────────────────────────────────────────

Family = tuple[int, int, int]
Matching = list[tuple[int, int]]


# ── Core simulation ────────────────────────────────────────────────────

def random_ncm(points: list[int]) -> Matching:
    """Generate a random non-crossing matching on a list of point indices."""
    if len(points) == 0:
        return []
    if len(points) == 2:
        return [(points[0], points[1])]
    valid_indices = list(range(1, len(points), 2))
    idx = random.choice(valid_indices)
    pair = (points[0], points[idx])
    inside = points[1:idx]
    outside = points[idx + 1:]
    return [pair] + random_ncm(inside) + random_ncm(outside)


def compute_depths(matching: Matching, total_points: int) -> list[int]:
    """Nesting depth at each segment around the perimeter.

    Returns list of length total_points + 1.
    depths[i] = nesting depth in the segment before endpoint i.
    Region color at segment i = (base + depths[i]) % 2,
    where base = 0 for polarity true, 1 for polarity false.
    """
    delta = [0] * total_points
    for a, b in matching:
        lo, hi = (a, b) if a < b else (b, a)
        delta[lo] += 1
        delta[hi] -= 1
    depths = [0] * (total_points + 1)
    for i in range(total_points):
        depths[i + 1] = depths[i] + delta[i]
    return depths


def edge_starts(eps:list[int]):
    """Starting endpoint index for each of the 6 edges."""
    s = 0
    out:list[int] = []
    for k in eps:
        out.append(s)
        s += k
    return out


def sim_flip(family_a: Family, matching_a: Matching, family_b: Family, matching_b: Matching, edge_a: int) -> str:
    """Simulate region coloring to find polarity relationship.

    edge_a: edge index on tile A that faces tile B.
    Returns 'same', 'flip', or 'conflict'.
    """
    ka_a, kb_a, kc_a = family_a
    ka_b, kb_b, kc_b = family_b
    eps_a = [ka_a, kb_a, kc_a, ka_a, kb_a, kc_a]
    eps_b = [ka_b, kb_b, kc_b, ka_b, kb_b, kc_b]

    depths_a = compute_depths(matching_a, sum(eps_a))
    depths_b = compute_depths(matching_b, sum(eps_b))

    edge_b = (edge_a + 3) % 6
    sa = edge_starts(eps_a)[edge_a]
    sb = edge_starts(eps_b)[edge_b]
    k = eps_a[edge_a]

    flip_vals: set[int] = set()
    for j in range(k + 1):
        da = depths_a[sa + j] % 2
        db = depths_b[sb + k - j] % 2
        flip_vals.add((da + db) % 2)

    if len(flip_vals) == 1:
        return 'flip' if flip_vals.pop() == 1 else 'same'
    return 'conflict'


def formula_flip(family_a: Family, family_b: Family, edge_a: int) -> str:
    """Flip formula: flipFactor(E) = sum EPs_A(0..E-1) + sum EPs_B(0..E') mod 2."""
    ka_a, kb_a, kc_a = family_a
    ka_b, kb_b, kc_b = family_b
    if edge_a == 0:
        f = (kb_b + kc_b) & 1
    elif edge_a == 1:
        f = (ka_a + kc_b) & 1
    elif edge_a == 2:
        f = (ka_a + kb_a) & 1
    elif edge_a == 3:
        f = (ka_a + kb_a + kc_a + ka_b) & 1
    elif edge_a == 4:
        f = (kb_a + kc_a + ka_b + kb_b) & 1
    else:
        f = (kc_a + ka_b + kb_b + kc_b) & 1
    return 'flip' if f else 'same'


def make_matching(family: Family) -> Matching:
    total = sum(family)
    return random_ncm(list(range(2 * total)))


def get_ep(family: Family, axis: int) -> int:
    return family[axis]


def set_ep(family: Family, axis: int, val: int) -> Family:
    f = list(family)
    f[axis] = val
    return (f[0], f[1], f[2])


# ── Hex neighborhood geometry ─────────────────────────────────────────
#
# For center at even q, neighbors N0..N5 sit at edges 0..5.
# Consecutive neighbors share an edge:
#   N_E ↔ N_{(E+1)%6}:
#     shared axis = (E + 2) % 3
#     N_E's edge facing N_{E+1}   = (E + 2) % 6
#     N_{E+1}'s edge facing N_E   = (E + 5) % 6
#
# Center ↔ N_E:
#     shared axis = E % 3
#     center's edge = E
#     N_E's edge    = (E + 3) % 6

def NB_SHARED_AXIS(e: int) -> int: return (e + 2) % 3    # axis shared between N_e and N_{e+1}
def NB_EDGE_FWD(e: int) -> int:    return (e + 2) % 6    # N_e's edge facing N_{e+1}
def NB_EDGE_REV(e: int) -> int:    return (e + 5) % 6    # N_{e+1}'s edge facing N_e
def CENTER_AXIS(e: int) -> int:    return e % 3           # axis shared between center and N_e


# ── Pair mode (original) ──────────────────────────────────────────────

def run_pair(n_samples: int, max_k: int) -> None:
    n_ok = n_bad = n_conflict = 0

    def rand_family() -> Family:
        return (random.randint(1, max_k), random.randint(1, max_k), random.randint(1, max_k))

    for _ in range(n_samples):
        family_a = rand_family()
        edge = random.randint(0, 5)
        shared_ep = family_a[edge % 3]

        family_b = set_ep(rand_family(), (edge + 3) % 6 % 3, shared_ep)

        ma = make_matching(family_a)
        mb = make_matching(family_b)

        sim = sim_flip(family_a, ma, family_b, mb, edge)
        frm = formula_flip(family_a, family_b, edge)

        if sim == 'conflict':
            n_conflict += 1
        elif sim == frm:
            n_ok += 1
        else:
            n_bad += 1

    total = n_ok + n_bad
    pct = 100 * n_ok / total if total else 0
    print(f"pair: {n_samples} samples, max_k={max_k}")
    print(f"  formula matches: {n_ok}/{total} ({pct:.1f}%)")
    print(f"  conflicts: {n_conflict}")
    if n_bad:
        print(f"  MISMATCHES: {n_bad}")


# ── Neighbor mode ─────────────────────────────────────────────────────

def random_edge_set():
    """Pick a random subset of 2-6 edges for neighbors."""
    n = random.randint(2, 6)
    return sorted(random.sample(range(6), n))


NAMED_CONFIGS = {
    'sandwich_0_3': [0, 3],
    'sandwich_1_4': [1, 4],
    'sandwich_2_5': [2, 5],
    'adj_01':       [0, 1],
    'adj_12':       [1, 2],
    'adj_23':       [2, 3],
    'triple_012':   [0, 1, 2],
    'triple_024':   [0, 2, 4],
    'quad_0123':    [0, 1, 2, 3],
    'penta':        [0, 1, 2, 3, 4],
    'full':         [0, 1, 2, 3, 4, 5],
}


def generate_neighborhood(center_fam: Family, edges: list[int], max_k: int, max_retries: int = 50) -> dict[int, tuple[Family, Matching, bool]] | None:
    """Generate a locally-consistent set of neighbors around a center tile.

    Returns dict {edge: (family, matching, polarity)} or None.
    """
    for _ in range(max_retries):
        # Generate families: shared EP with center must match,
        # shared EP between consecutive neighbors must match.
        fam_lists: dict[int, list[int]] = {}
        for e in edges:
            fam_lists[e] = [random.randint(1, max_k) for _ in range(3)]
            # match center's shared EP
            axis_c = CENTER_AXIS(e)
            fam_lists[e][axis_c] = center_fam[axis_c]

        # Enforce neighbor-neighbor EP constraints for consecutive pairs
        for i, e in enumerate(edges):
            e_next = (e + 1) % 6
            if e_next not in fam_lists:
                continue
            axis = NB_SHARED_AXIS(e)
            # Both must agree — pick one and enforce
            val = fam_lists[e][axis]
            if fam_lists[e_next][axis] != val:
                fam_lists[e_next][axis] = val

        # Re-check center EP constraints weren't broken
        for e in edges:
            axis_c = CENTER_AXIS(e)
            if fam_lists[e][axis_c] != center_fam[axis_c]:
                fam_lists[e][axis_c] = center_fam[axis_c]

        # Convert to tuples, generate matchings
        families: dict[int, Family] = {
            e: (f[0], f[1], f[2]) for e, f in fam_lists.items()
        }
        matchings: dict[int, Matching] = {e: make_matching(families[e]) for e in edges}

        # Assign polarity: first neighbor is True, propagate via simulation
        polarities: dict[int, bool] = {}
        edge_list = sorted(edges)
        polarities[edge_list[0]] = True

        chain_ok = True
        for i in range(len(edge_list) - 1):
            e = edge_list[i]
            e_next = edge_list[i + 1]
            if (e + 1) % 6 == e_next:
                # Consecutive: propagate polarity
                # N_e faces N_{e+1} via edge (e+2)%6
                fwd_edge = NB_EDGE_FWD(e)
                rel = sim_flip(families[e], matchings[e],
                               families[e_next], matchings[e_next],
                               fwd_edge)
                if rel == 'conflict':
                    chain_ok = False
                    break
                polarities[e_next] = (not polarities[e]) if rel == 'flip' else polarities[e]
            else:
                # Not consecutive: independent, pick random
                polarities[e_next] = random.choice([True, False])

        if not chain_ok:
            continue

        # If ring wraps (first and last are consecutive), check consistency
        if len(edge_list) >= 2:
            e_last = edge_list[-1]
            e_first = edge_list[0]
            if (e_last + 1) % 6 == e_first:
                fwd_edge = NB_EDGE_FWD(e_last)
                rel = sim_flip(families[e_last], matchings[e_last],
                               families[e_first], matchings[e_first],
                               fwd_edge)
                if rel == 'conflict':
                    continue
                required = (not polarities[e_last]) if rel == 'flip' else polarities[e_last]
                if required != polarities[e_first]:
                    continue  # ring inconsistency

        return {e: (families[e], matchings[e], polarities[e]) for e in edges}

    return None  # couldn't generate consistent neighborhood


CfgStats = dict[str, int]

def run_neighbor(n_samples: int, max_k: int) -> None:
    consistent = 0
    conflict = 0
    formula_ok = 0
    formula_bad = 0
    gen_fail = 0
    by_config: dict[str, CfgStats] = {}

    def rand_family() -> Family:
        return (random.randint(1, max_k), random.randint(1, max_k), random.randint(1, max_k))

    for _ in range(n_samples):
        # Random or named configuration
        if random.random() < 0.3:
            name, edges = random.choice(list(NAMED_CONFIGS.items()))
        else:
            edges = random_edge_set()
            name = f'random_{len(edges)}'

        if name not in by_config:
            by_config[name] = {'consistent': 0, 'conflict': 0,
                               'formula_ok': 0, 'formula_bad': 0,
                               'gen_fail': 0}
        cfg = by_config[name]

        center_fam = rand_family()
        center_matching = make_matching(center_fam)

        hood = generate_neighborhood(center_fam, edges, max_k)
        if hood is None:
            gen_fail += 1
            cfg['gen_fail'] += 1
            continue

        # For each neighbor, compute required center polarity via simulation
        # and via formula
        sim_pols: dict[int, bool] = {}
        frm_pols: dict[int, bool] = {}
        any_conflict = False

        for e, (nb_fam, nb_match, nb_pol) in hood.items():
            # Simulation: what polarity does center need on edge e?
            rel_sim = sim_flip(center_fam, center_matching,
                               nb_fam, nb_match, e)
            rel_frm = formula_flip(center_fam, nb_fam, e)

            if rel_sim == 'conflict':
                any_conflict = True
                break

            sim_pols[e] = (not nb_pol) if rel_sim == 'flip' else nb_pol
            frm_pols[e] = (not nb_pol) if rel_frm == 'flip' else nb_pol

        if any_conflict:
            conflict += 1
            cfg['conflict'] += 1
            continue

        # Check consistency across all neighbors
        sim_vals = set(sim_pols.values())

        if len(sim_vals) > 1:
            conflict += 1
            cfg['conflict'] += 1
        else:
            consistent += 1
            cfg['consistent'] += 1

            if sim_pols == frm_pols:
                formula_ok += 1
                cfg['formula_ok'] += 1
            else:
                formula_bad += 1
                cfg['formula_bad'] += 1
                print(f"  MISMATCH: config={name} center={center_fam} "
                      f"edges={edges}")
                for e in edges:
                    nb_fam = hood[e][0]
                    print(f"    edge {e}: nb={nb_fam} sim={sim_pols[e]} "
                          f"frm={frm_pols[e]}")

    print(f"neighbor: {n_samples} samples, max_k={max_k}")
    print(f"  consistent: {consistent}  "
          f"(formula ok: {formula_ok}, bad: {formula_bad})")
    print(f"  conflict (unplaceable): {conflict}")
    print(f"  gen_fail: {gen_fail}")
    print()

    for name in sorted(by_config):
        c = by_config[name]
        total = c['consistent'] + c['conflict'] + c['gen_fail']
        if total == 0:
            continue
        print(f"  {name:20s}  ok={c['consistent']:5d}  conflict={c['conflict']:5d}  "
              f"formula_bad={c['formula_bad']:3d}  gen_fail={c['gen_fail']:3d}")


# ── Main ──────────────────────────────────────────────────────────────

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'neighbor'
    n_samples = int(sys.argv[2]) if len(sys.argv) > 2 else 10000
    max_k = int(sys.argv[3]) if len(sys.argv) > 3 else 6

    if mode == 'pair':
        run_pair(n_samples, max_k)
    elif mode == 'neighbor':
        run_neighbor(n_samples, max_k)
    else:
        print(f"Unknown mode: {mode}. Use 'pair' or 'neighbor'.", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
