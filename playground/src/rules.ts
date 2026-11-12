/**
 * Placement rules — a port of TruchetNFT._checkNeighbors / _placeTile.
 *
 * Pure functions over a cell lookup; no state of their own. Additional
 * playground-only limits (per-axis ≥ 1, sum ≤ solver MAX_ARCS, index range)
 * are enforced too, since the solver can't render anything outside them.
 */

import { EP_MIN, EP_SUM_MAX, EP_SUM_DELTA } from './config'
import { catalan } from './catalan'
import { neighbor } from './hex'

export type Eps = readonly [ka: number, kb: number, kc: number]

export interface TileLike {
  ka: number
  kb: number
  kc: number
  polarity: boolean
}

export type Lookup = (q: number, r: number) => TileLike | undefined

export type RejectCode =
  | 'occupied'
  | 'invalid-eps'
  | 'edge-mismatch'
  | 'polarity-conflict'
  | 'sum-delta'
  | 'not-adjacent'
  | 'index-range'
  | 'index-used'

export type Check =
  | { ok: true; polarity: boolean; hasNeighbor: boolean }
  | { ok: false; code: RejectCode; reason: string }

const AXIS = ['ka', 'kb', 'kc'] as const

/** EP count of a tile on a given edge: edges 0,3 → ka; 1,4 → kb; 2,5 → kc. */
export function edgeEp(t: TileLike, edge: number): number {
  const i = edge % 3
  return i === 0 ? t.ka : i === 1 ? t.kb : t.kc
}

/**
 * Parity of the colour flip between a new tile A and its neighbour B across
 * A's edge E. Corner colour = nesting depth ≡ Σ EPs before that corner (mod 2),
 * which is independent of the matching, so equating the colours of the two
 * shared corners gives (TruchetNFT.sol):
 *
 *   E=0: nb.kb + nb.kc      E=3: ka + kb + kc + nb.ka
 *   E=1: ka + nb.kc         E=4: kb + kc + nb.ka + nb.kb
 *   E=2: ka + kb            E=5: kc + nb.ka + nb.kb + nb.kc
 */
export function flipFactor(edge: number, eps: Eps, nb: TileLike): number {
  const [ka, kb, kc] = eps
  switch (edge) {
    case 0: return (nb.kb + nb.kc) & 1
    case 1: return (ka + nb.kc) & 1
    case 2: return (ka + kb) & 1
    case 3: return (ka + kb + kc + nb.ka) & 1
    case 4: return (kb + kc + nb.ka + nb.kb) & 1
    case 5: return (kc + nb.ka + nb.kb + nb.kc) & 1
    default: throw new Error(`invalid edge: ${edge}`)
  }
}

/** The polarity a tile with `eps` must have to agree with neighbour `nb` across `edge`. */
export function requiredPolarity(edge: number, eps: Eps, nb: TileLike): boolean {
  return flipFactor(edge, eps, nb) === 0 ? nb.polarity : !nb.polarity
}

/** Playground EP limits (the contract only rejects all-zero). */
export function checkEps(eps: Eps): Check | null {
  const [ka, kb, kc] = eps
  const sum = ka + kb + kc
  if (!eps.every(e => Number.isInteger(e) && e >= EP_MIN) || sum > EP_SUM_MAX) {
    return { ok: false, code: 'invalid-eps', reason: `EPs must each be ≥ ${EP_MIN} with sum ≤ ${EP_SUM_MAX}` }
  }
  return null
}

/**
 * Edge matching, polarity derivation and the EP-sum delta rule.
 * Mirrors _checkNeighbors exactly, including the default polarity (true)
 * for a tile with no neighbours.
 */
export function checkNeighbors(get: Lookup, q: number, r: number, eps: Eps): Check {
  let polarity = true
  let polaritySet = false
  let hasNeighbor = false
  const constrained = [false, false, false]
  const nbs: (TileLike | undefined)[] = []

  for (let edge = 0; edge < 6; edge++) {
    const n = neighbor(q, r, edge)
    const nb = get(n.q, n.r)
    nbs.push(nb)
    if (!nb) continue
    hasNeighbor = true

    const theirs = edgeEp(nb, (edge + 3) % 6)
    const ours = eps[edge % 3]
    if (ours !== theirs) {
      return {
        ok: false, code: 'edge-mismatch',
        reason: `${AXIS[edge % 3]} must be ${theirs} to match the neighbour on edge ${edge}`,
      }
    }
    constrained[edge % 3] = true

    const req = requiredPolarity(edge, eps, nb)
    if (!polaritySet) {
      polarity = req
      polaritySet = true
    } else if (polarity !== req) {
      return { ok: false, code: 'polarity-conflict', reason: `Neighbours require opposite polarities (edge ${edge})` }
    }
  }

  if (hasNeighbor) {
    let ourFree = 0
    for (let i = 0; i < 3; i++) if (!constrained[i]) ourFree += eps[i]
    for (const nb of nbs) {
      if (!nb) continue
      const nbEps = [nb.ka, nb.kb, nb.kc]
      let nbFree = 0
      for (let i = 0; i < 3; i++) if (!constrained[i]) nbFree += nbEps[i]
      if (Math.abs(ourFree - nbFree) > EP_SUM_DELTA) {
        return {
          ok: false, code: 'sum-delta',
          reason: `Free EP sum ${ourFree} is more than ${EP_SUM_DELTA} away from a neighbour's ${nbFree}`,
        }
      }
    }
  }

  return { ok: true, polarity, hasNeighbor }
}

export interface PlaceContext {
  get: Lookup
  /** True if (eps, idx) has already been placed anywhere. */
  isUsed: (eps: Eps, idx: bigint) => boolean
  /** Require at least one neighbour (false only for the seed tile / imports). */
  requireAdjacent: boolean
}

/** Full placement check for (q, r) with a family and Catalan index. */
export function checkPlacement(ctx: PlaceContext, q: number, r: number, eps: Eps, idx: bigint): Check {
  if (ctx.get(q, r)) return { ok: false, code: 'occupied', reason: 'Cell is occupied' }
  const bad = checkEps(eps)
  if (bad) return bad
  const res = checkNeighbors(ctx.get, q, r, eps)
  if (!res.ok) return res
  if (ctx.requireAdjacent && !res.hasNeighbor) {
    return { ok: false, code: 'not-adjacent', reason: 'Must be adjacent to an existing tile' }
  }
  const n = eps[0] + eps[1] + eps[2]
  if (idx < 0n || idx >= catalan(n)) {
    return { ok: false, code: 'index-range', reason: `Index must be below C(${n})` }
  }
  if (ctx.isUsed(eps, idx)) {
    return { ok: false, code: 'index-used', reason: 'This family + index is already placed' }
  }
  return res
}
