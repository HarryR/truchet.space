/**
 * Line model — a gap-free way to choose every tile's family.
 *
 * Opposite edges of a tile share an EP count, and a neighbour must match it,
 * so each count is constant along a whole straight line of hexes. A complete
 * tiling is therefore just three rings of numbers, one value per line:
 *
 *   ka — 256 lines, index (r − ⌊q/2⌋) mod 256   (through edges 0/3)
 *   kb — 512 lines, index q                      (through edges 1/4, the columns)
 *   kc — 256 lines, index (r + ⌈q/2⌉) mod 256   (through edges 2/5)
 *
 * The family at a cell is read off its three lines, so every cell is always
 * placeable in any order. Two conditions make that hold on the torus:
 *
 *   - each ring is closed, with adjacent lines differing by at most 1
 *     (which also keeps the EP-sum delta rule satisfied), and
 *   - the sum of all line values is even (otherwise polarity fails to close
 *     up when the pattern wraps around the torus).
 */

import { EP_MIN, EP_SUM_MAX, GRID_SIZE, LINE_MAX, LINE_MIN } from './config'
import type { Eps } from './rules'

const HALF = GRID_SIZE / 2

export interface Lines {
  a: Uint8Array
  b: Uint8Array
  c: Uint8Array
}

export interface LineOptions {
  /** Smallest per-line EP count. */
  min?: number
  /** Largest per-line EP count (3 × max must not exceed the solver's limit). */
  max?: number
}

/** The three line indices of cell (q, r). */
export function lineIndex(q: number, r: number): [ia: number, ib: number, ic: number] {
  return [
    (r - (q >> 1) + GRID_SIZE) % HALF,
    q,
    (r + ((q + 1) >> 1)) % HALF,
  ]
}

/** Family (ka, kb, kc) of cell (q, r). */
export function familyAt(lines: Lines, q: number, r: number): Eps {
  const [ia, ib, ic] = lineIndex(q, r)
  return [lines.a[ia], lines.b[ib], lines.c[ic]]
}

/** Seeded PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Random closed walk of length n in [min, max]: each line steps −1, 0 or +1
 * from the previous one, and the last is within 1 of the first.
 */
function ring(n: number, min: number, max: number, rand: () => number): Uint8Array {
  const v = new Uint8Array(n)
  v[0] = min + Math.floor(rand() * (max - min + 1))
  for (let i = 1; i < n; i++) {
    const left = n - i // steps remaining to get back to v[0]
    const opts: number[] = []
    for (let x = v[i - 1] - 1; x <= v[i - 1] + 1; x++) {
      if (x >= min && x <= max && Math.abs(x - v[0]) <= left) opts.push(x)
    }
    v[i] = opts[Math.floor(rand() * opts.length)]
  }
  return v
}

/** Generate the three rings for a seed. Deterministic. */
export function makeLines(seed: number, opts: LineOptions = {}): Lines {
  const min = opts.min ?? LINE_MIN
  const max = opts.max ?? LINE_MAX
  if (min < EP_MIN || max < min || 3 * max > EP_SUM_MAX) throw new Error(`invalid line range ${min}..${max}`)
  const rand = mulberry32(seed)
  const a = ring(HALF, min, max, rand)
  const b = ring(GRID_SIZE, min, max, rand)
  const sum = (v: Uint8Array) => v.reduce((s, x) => s + x, 0)
  const ab = sum(a) + sum(b)
  // Torus parity: redraw the last ring until the total is even.
  for (;;) {
    const c = ring(HALF, min, max, rand)
    if (min === max && (ab + sum(c)) % 2 !== 0) throw new Error('constant rings have an odd total; widen the range')
    if ((ab + sum(c)) % 2 === 0) return { a, b, c }
  }
}
