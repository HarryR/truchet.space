import { describe, expect, it } from 'vitest'
import { neighbor } from './hex'
import { checkPlacement, requiredPolarity, type Eps, type TileLike } from './rules'
import { World } from './world'

/** Seeded PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Positional polarity from solver/c/truchet.c hexagon_grid() for a uniform grid. */
function cGridPolarity(ka: number, kb: number, kc: number, gc: number, gr: number): boolean {
  const fab = (ka + kb) % 2, fac = (ka + kc) % 2, fbc = (kb + kc) % 2
  const flip = (gr * fac + Math.floor((gc + 1) / 2) * fbc + Math.floor(gc / 2) * fab) % 2
  return flip === 0
}

const FAMILIES: Eps[] = [
  [1, 1, 1], [1, 1, 2], [1, 2, 1], [2, 1, 1], [1, 2, 2], [2, 1, 2], [2, 2, 1],
  [2, 2, 2], [1, 2, 3], [3, 2, 1], [2, 3, 4], [3, 3, 3], [4, 1, 6],
]

describe('polarity rules', () => {
  it.each(FAMILIES)('uniform %i,%i,%i grid matches the C solver positional polarity', (ka, kb, kc) => {
    const eps: Eps = [ka, kb, kc]
    // Fill a 10×10 block column by column; every placement is adjacent to an
    // earlier one. Uniqueness is irrelevant here (small families would run out).
    const tiles = new Map<string, TileLike>()
    const get = (q: number, r: number) => tiles.get(`${q},${r}`)
    for (let q = 0; q < 10; q++) {
      for (let r = 0; r < 10; r++) {
        const res = checkPlacement({ get, isUsed: () => false, requireAdjacent: tiles.size > 0 }, q, r, eps, 0n)
        expect(res.ok, `(${q},${r}) ${!res.ok && res.reason}`).toBe(true)
        if (!res.ok) return
        expect(res.polarity, `polarity at (${q},${r})`).toBe(cGridPolarity(ka, kb, kc, q, r))
        tiles.set(`${q},${r}`, { ka, kb, kc, polarity: res.polarity })
      }
    }
  })

  it('is symmetric: deriving A from B, then B from A, round-trips', () => {
    for (let edge = 0; edge < 6; edge++) {
      const back = (edge + 3) % 6
      for (let i = 0; i < 4000; i++) {
        const r = rng(i * 7 + edge)
        const a: [number, number, number] = [1 + Math.floor(r() * 5), 1 + Math.floor(r() * 5), 1 + Math.floor(r() * 5)]
        const b: [number, number, number] = [1 + Math.floor(r() * 5), 1 + Math.floor(r() * 5), 1 + Math.floor(r() * 5)]
        b[edge % 3] = a[edge % 3] // shared edge must match
        for (const pb of [true, false]) {
          const B: TileLike = { ka: b[0], kb: b[1], kc: b[2], polarity: pb }
          const pa = requiredPolarity(edge, a, B)
          const A: TileLike = { ka: a[0], kb: a[1], kc: a[2], polarity: pa }
          expect(requiredPolarity(back, b, A)).toBe(pb)
        }
      }
    }
  })
})

describe('rule checks', () => {
  it('enforces the contract rules', () => {
    const tiles = new Map<string, TileLike>()
    const get = (q: number, r: number) => tiles.get(`${q},${r}`)
    const used = new Set<string>()
    const ctx = (requireAdjacent: boolean) => ({ get, isUsed: (e: Eps, i: bigint) => used.has(`${e}:${i}`), requireAdjacent })
    expect(checkPlacement(ctx(false), 0, 0, [2, 2, 2], 7n)).toMatchObject({ ok: true, polarity: true })
    tiles.set('0,0', { ka: 2, kb: 2, kc: 2, polarity: true })
    used.add('2,2,2:7')
    expect(checkPlacement(ctx(true), 0, 0, [2, 2, 2], 8n)).toMatchObject({ ok: false, code: 'occupied' })
    expect(checkPlacement(ctx(true), 5, 5, [2, 2, 2], 8n)).toMatchObject({ ok: false, code: 'not-adjacent' })
    // Edge 0 neighbour of (0,0) is (1,0); it must have ka = 2.
    expect(checkPlacement(ctx(true), 1, 0, [3, 2, 2], 0n)).toMatchObject({ ok: false, code: 'edge-mismatch' })
    // Free axes kb+kc = 4 on the seed; 4+3 = 7 is more than 2 away.
    expect(checkPlacement(ctx(true), 1, 0, [2, 4, 3], 0n)).toMatchObject({ ok: false, code: 'sum-delta' })
    expect(checkPlacement(ctx(true), 1, 0, [2, 2, 2], 7n)).toMatchObject({ ok: false, code: 'index-used' })
    expect(checkPlacement(ctx(true), 1, 0, [2, 2, 2], 132n)).toMatchObject({ ok: false, code: 'index-range' })
    expect(checkPlacement(ctx(true), 1, 0, [2, 2, 2], 131n).ok).toBe(true)
  })
})

/** Tap `n` random frontier cells. */
function tap(w: World, n: number, rand: () => number) {
  for (let i = 0; i < n; i++) {
    const f = [...w.frontier()]
    const k = f[Math.floor(rand() * f.length)]
    const res = w.place(k >> 9, k & 511, undefined, rand)
    if (!res.ok) throw new Error(`(${k >> 9},${k & 511}) rejected: ${res.reason}`)
  }
}

describe('world', () => {
  it('only places next to existing tiles, and wraps around the torus', () => {
    const w = new World(1)
    expect(w.place(0, 0).ok).toBe(true)
    expect(w.place(0, 0)).toMatchObject({ ok: false, code: 'occupied' })
    expect(w.place(5, 5)).toMatchObject({ ok: false, code: 'not-adjacent' })
    expect(w.canPlace(5, 5)).toBe(false)
    // (511, 511) is the edge-3 neighbour of (0, 0).
    expect(neighbor(0, 0, 3)).toEqual({ q: 511, r: 511 })
    expect(w.canPlace(-1, -1)).toBe(true)
    expect(w.place(-1, -1).ok).toBe(true)
    expect(w.get(511, 511)).toBeDefined()
  })

  it('tracks the frontier and undoes tile by tile, keeping the first', () => {
    const w = new World(2)
    w.reset(2, 10, 10)
    expect(w.frontier().size).toBe(6)
    expect(w.canUndo).toBe(false)
    tap(w, 30, rng(1))
    expect(w.size).toBe(31)
    while (w.undo()) { /* all the way back */ }
    expect(w.size).toBe(1)
    expect(w.frontier().size).toBe(6)
  })

  it.each([3, 4, 5])('seed %i: any tap order works and every tile agrees with its neighbours', (seed) => {
    const w = new World(seed)
    w.reset(seed)
    tap(w, 1500, rng(seed))
    for (const t of w.all()) {
      expect([t.ka, t.kb, t.kc]).toEqual([...w.familyAt(t.q, t.r)])
      for (let e = 0; e < 6; e++) {
        const n = neighbor(t.q, t.r, e)
        const nb = w.get(n.q, n.r)
        if (!nb) continue
        expect(nb[(['ka', 'kb', 'kc'] as const)[e % 3]]).toBe(t[(['ka', 'kb', 'kc'] as const)[e % 3]])
        expect(requiredPolarity(e, [t.ka, t.kb, t.kc], nb)).toBe(t.polarity)
      }
    }
  })

  it('round-trips through JSON', () => {
    const w = new World(7)
    w.reset(7, 3, 4)
    tap(w, 50, rng(7))
    const json = JSON.parse(JSON.stringify(w.toJSON()))
    const w2 = new World()
    expect(w2.load(json)).toEqual({ loaded: w.size, rejected: 0 })
    expect(w2.seed).toBe(7)
    expect([...w2.all()]).toEqual([...w.all()])
  })
})
