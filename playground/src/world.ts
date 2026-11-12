/**
 * World state: the tiles on the torus and the frontier (empty cells adjacent
 * to a tile). DOM-free.
 *
 * Every cell's family comes from the world's line rings (see lines.ts), which
 * are derived from `seed`; the only per-tile randomness is the matching index.
 */

import { catalan, randomBelow } from './catalan'
import { neighbor, wrap } from './hex'
import { familyAt, makeLines, type Lines } from './lines'
import { checkPlacement, type Check, type Eps } from './rules'

export interface Tile {
  q: number
  r: number
  ka: number
  kb: number
  kc: number
  polarity: boolean
  idx: bigint
}

/** Packed cell key: (q << 9) | r. */
export function cellKey(q: number, r: number): number {
  return (wrap(q) << 9) | wrap(r)
}

export function keyQ(k: number): number { return k >> 9 }
export function keyR(k: number): number { return k & 511 }

export type ChangeListener = (changed: number[]) => void

export class World {
  private tiles = new Map<number, Tile>()
  private frontierSet = new Set<number>()
  /** Placement order, so a save can be replayed tile by tile. */
  private order: Tile[] = []
  private listeners = new Set<ChangeListener>()
  private pendingChanged: number[] = []
  private _seed = 0
  private lines: Lines

  constructor(seed = 1) {
    this._seed = seed
    this.lines = makeLines(seed)
  }

  readonly get = (q: number, r: number): Tile | undefined => this.tiles.get(cellKey(q, r))

  get seed(): number { return this._seed }
  get size(): number { return this.tiles.size }

  all(): IterableIterator<Tile> { return this.tiles.values() }
  frontier(): ReadonlySet<number> { return this.frontierSet }

  /** The family every tile at (q, r) has in this world. */
  familyAt(q: number, r: number): Eps {
    return familyAt(this.lines, wrap(q), wrap(r))
  }

  /** True if (q, r) is empty and next to a tile (or the world is empty). */
  canPlace(q: number, r: number): boolean {
    return this.size === 0 ? true : this.frontierSet.has(cellKey(q, r))
  }

  /**
   * Place the tile that belongs at (q, r), with a random matching (or `idx`).
   * Must be adjacent to an existing tile unless the world is empty.
   */
  place(q: number, r: number, idx?: bigint, rand: () => number = Math.random): Check {
    q = wrap(q); r = wrap(r)
    const eps = this.familyAt(q, r)
    idx ??= randomBelow(catalan(eps[0] + eps[1] + eps[2]), rand)
    const res = checkPlacement({ get: this.get, isUsed: () => false, requireAdjacent: this.size > 0 }, q, r, eps, idx)
    if (!res.ok) return res
    const tile: Tile = { q, r, ka: eps[0], kb: eps[1], kc: eps[2], polarity: res.polarity, idx }
    this.insert(tile)
    this.order.push(tile)
    this.flush()
    return res
  }

  /**
   * Re-roll the matching of the tile at (q, r): a new random Catalan index,
   * always different from the current one. The family and polarity are fixed
   * by the cell and its neighbours, so the result stays valid. Returns the new
   * tile, or undefined if the cell is empty.
   */
  regenerate(q: number, r: number, rand: () => number = Math.random): Tile | undefined {
    const k = cellKey(q, r)
    const old = this.tiles.get(k)
    if (!old) return undefined
    const total = catalan(old.ka + old.kb + old.kc)
    if (total < 2n) return old
    // Uniform over the other total − 1 indices.
    let idx = randomBelow(total - 1n, rand)
    if (idx >= old.idx) idx++
    const tile: Tile = { ...old, idx }
    this.tiles.set(k, tile)
    this.order[this.order.indexOf(old)] = tile
    this.pendingChanged.push(k)
    this.flush()
    return tile
  }

  /** Start over with new line rings and a single tile at (q, r). */
  reset(seed: number, q = 0, r = 0) {
    this.clear(seed)
    this.place(q, r)
  }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ── Serialisation ──

  toJSON(): SavedWorld {
    return {
      version: 2,
      seed: this._seed,
      tiles: this.order.map(t => [t.q, t.r, t.idx.toString()]),
    }
  }

  /**
   * Replace the world with saved data. Tiles are re-placed in saved order
   * (families and polarity are re-derived from the seed). Returns the number
   * rejected.
   */
  load(data: unknown): { loaded: number; rejected: number } {
    const saved = parseSaved(data)
    this.clear(saved.seed)
    let loaded = 0, rejected = 0
    for (const [q, r, idxStr] of saved.tiles) {
      let idx: bigint
      try { idx = BigInt(idxStr) } catch { rejected++; continue }
      if (this.place(q, r, idx).ok) loaded++
      else rejected++
    }
    return { loaded, rejected }
  }

  // ── Internals ──

  private clear(seed: number) {
    for (const t of [...this.tiles.values()]) this.delete(t)
    this.order = []
    this._seed = seed
    this.lines = makeLines(seed)
    this.flush()
  }

  private insert(t: Tile) {
    const k = cellKey(t.q, t.r)
    this.tiles.set(k, t)
    this.frontierSet.delete(k)
    this.pendingChanged.push(k)
    for (let e = 0; e < 6; e++) {
      const n = neighbor(t.q, t.r, e)
      const nk = cellKey(n.q, n.r)
      if (!this.tiles.has(nk)) this.frontierSet.add(nk)
      this.pendingChanged.push(nk)
    }
  }

  private delete(t: Tile) {
    const k = cellKey(t.q, t.r)
    this.tiles.delete(k)
    this.pendingChanged.push(k)
    if (this.hasNeighborTile(t.q, t.r)) this.frontierSet.add(k)
    for (let e = 0; e < 6; e++) {
      const n = neighbor(t.q, t.r, e)
      const nk = cellKey(n.q, n.r)
      this.pendingChanged.push(nk)
      if (!this.tiles.has(nk) && !this.hasNeighborTile(n.q, n.r)) this.frontierSet.delete(nk)
    }
  }

  private hasNeighborTile(q: number, r: number): boolean {
    for (let e = 0; e < 6; e++) {
      const n = neighbor(q, r, e)
      if (this.tiles.has(cellKey(n.q, n.r))) return true
    }
    return false
  }

  private flush() {
    if (this.pendingChanged.length === 0) return
    const changed = [...new Set(this.pendingChanged)]
    this.pendingChanged = []
    for (const fn of this.listeners) fn(changed)
  }
}

// ── Saved format ──

/** [q, r, catalanIndex (decimal string)] in placement order. */
export type SavedTile = [number, number, string]

export interface SavedWorld {
  version: 2
  seed: number
  tiles: SavedTile[]
}

function parseSaved(data: unknown): SavedWorld {
  const d = data as Partial<SavedWorld> | null
  if (!d || d.version !== 2 || !Number.isInteger(d.seed) || !Array.isArray(d.tiles)) {
    throw new Error('Not a truchet playground save (expected version 2)')
  }
  const tiles = d.tiles.filter((t): t is SavedTile =>
    Array.isArray(t) && t.length === 3 && Number.isInteger(t[0]) && Number.isInteger(t[1]) && typeof t[2] === 'string')
  return { version: 2, seed: d.seed!, tiles }
}
