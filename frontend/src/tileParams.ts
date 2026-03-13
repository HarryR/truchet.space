/**
 * Auto-pick valid (ka, kb, kc, catalanIndex) for an empty cell based on neighbor constraints.
 */

import { fetchTile, isCatalanUsed, type OnChainTile } from './contracts'
import { neighbor } from './hex'

/** Catalan numbers C(0)..C(30) — more than enough for any realistic EP sum. */
const CATALAN: bigint[] = [1n]
;(function precompute() {
  for (let i = 1; i <= 30; i++) {
    CATALAN[i] = CATALAN[i - 1] * BigInt(2 * (2 * i - 1)) / BigInt(i + 1)
  }
})()

/** Returns Catalan(n) or 0 if out of range. */
export function catalan(n: number): bigint {
  if (n < 0 || n >= CATALAN.length) return 0n
  return CATALAN[n]
}

export interface TileConstraints {
  /** Fixed EP per axis — 0 means free. */
  fixed: [number, number, number]
  /** Which axes are free (user-adjustable). */
  freeAxes: Set<number>
  /** Default EP values (constrained axes filled, free axes set to a safe default). */
  defaults: [number, number, number]
  /** Each neighbor's sum of EPs on FREE axes only — used for delta range checks. */
  neighborFreeSums: number[]
}

export interface TileParams {
  ka: number
  kb: number
  kc: number
  catalanIndex: bigint
}

/**
 * Pure constraint analysis from pre-fetched neighbor data.
 * neighbors[edge] is the on-chain tile across that edge, or null if empty/unfetched.
 */
export function computeConstraintsFromNeighbors(nbTiles: (OnChainTile | null)[]): TileConstraints {
  const fixed: [number, number, number] = [0, 0, 0]
  const freeAxes = new Set([0, 1, 2])

  for (let edge = 0; edge < 6; edge++) {
    const tile = nbTiles[edge]
    if (tile) {
      const axis = edge % 3
      fixed[axis] = axis === 0 ? tile.ka : axis === 1 ? tile.kb : tile.kc
      freeAxes.delete(axis)
    }
  }

  // Default free axes: copy from nearest neighbor to preserve EP parity
  const defaults: [number, number, number] = [...fixed]
  const refNeighbor = nbTiles.find(n => n != null)
  for (const axis of freeAxes) {
    if (refNeighbor) {
      const refEp = axis === 0 ? refNeighbor.ka : axis === 1 ? refNeighbor.kb : refNeighbor.kc
      defaults[axis] = refEp > 0 ? refEp : 2
    } else {
      defaults[axis] = 2
    }
  }

  // Collect each neighbor's sum of EPs on free axes only
  const neighborFreeSums: number[] = []
  for (let edge = 0; edge < 6; edge++) {
    const nb = nbTiles[edge]
    if (!nb) continue
    let freeSum = 0
    for (const axis of freeAxes) {
      freeSum += axis === 0 ? nb.ka : axis === 1 ? nb.kb : nb.kc
    }
    neighborFreeSums.push(freeSum)
  }

  return { fixed, freeAxes, defaults, neighborFreeSums }
}

const ZERO_ADDR = '0x' + '0'.repeat(40)

/**
 * Analyze neighbor constraints for an empty cell by fetching neighbor tiles from RPC.
 */
export async function computeConstraints(q: number, r: number): Promise<TileConstraints> {
  const nbTiles: (OnChainTile | null)[] = []
  for (let edge = 0; edge < 6; edge++) {
    const { q: nq, r: nr } = neighbor(q, r, edge)
    let tile: OnChainTile
    try {
      tile = await fetchTile(nq, nr)
    } catch {
      nbTiles[edge] = null
      continue
    }
    nbTiles[edge] = tile.tileOwner !== ZERO_ADDR ? tile : null
  }
  return computeConstraintsFromNeighbors(nbTiles)
}

/**
 * Compute the valid range for a single free axis given current EP values and neighbor sums.
 * Takes into account the EP sum delta ≤ 2 constraint across ALL neighbors simultaneously.
 */
export function axisRange(
  axis: number,
  currentEps: [number, number, number],
  constraints: TileConstraints,
): [number, number] {
  if (!constraints.freeAxes.has(axis)) return [currentEps[axis], currentEps[axis]]

  let otherFreeSum = 0
  for (const a of constraints.freeAxes) {
    if (a !== axis) otherFreeSum += currentEps[a]
  }
  let lo = 1
  let hi = 20
  for (const nbFreeSum of constraints.neighborFreeSums) {
    lo = Math.max(lo, nbFreeSum - 2 - otherFreeSum)
    hi = Math.min(hi, nbFreeSum + 2 - otherFreeSum)
  }
  return [Math.max(1, lo), Math.max(lo, hi)]
}

/**
 * Find the next valid EP value in a direction (+1 or -1), respecting
 * the sum-delta range. Returns null if no valid value exists in that direction.
 */
export function nextValidValue(
  axis: number,
  currentEps: [number, number, number],
  dir: 1 | -1,
  constraints: TileConstraints,
): number | null {
  const [lo, hi] = axisRange(axis, currentEps, constraints)
  const v = currentEps[axis] + dir
  if (v < lo || v > hi) return null
  return v
}

/**
 * Pick a random available Catalan index for the given EP configuration.
 */
export async function pickCatalanIndex(ka: number, kb: number, kc: number): Promise<bigint> {
  const epSum = ka + kb + kc
  const maxIdx = catalan(epSum)
  if (maxIdx === 0n) throw new Error(`No valid Catalan number for EP sum ${epSum}`)

  async function checkUsed(idx: bigint): Promise<boolean> {
    try {
      return await isCatalanUsed(ka, kb, kc, idx)
    } catch {
      return false
    }
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const idx = BigInt(Math.floor(Math.random() * Number(maxIdx < 1000000n ? maxIdx : 1000000n)))
    if (!(await checkUsed(idx))) return idx
  }

  throw new Error('Could not find available Catalan index')
}
