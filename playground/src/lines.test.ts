import { describe, expect, it } from 'vitest'
import { GRID_SIZE, LINE_MAX, LINE_MIN } from './config'
import { neighbor } from './hex'
import { familyAt, lineIndex, makeLines } from './lines'
import { checkNeighbors, requiredPolarity, type TileLike } from './rules'

const HALF = GRID_SIZE / 2
const key = (q: number, r: number) => (q << 9) | r

describe('line model', () => {
  it('line indices are constant along their line and step by 1 across it', () => {
    for (let q = 0; q < GRID_SIZE; q++) {
      for (let r = 0; r < GRID_SIZE; r += 7) {
        const me = lineIndex(q, r)
        const mod = [HALF, GRID_SIZE, HALF]
        for (let e = 0; e < 6; e++) {
          const n = neighbor(q, r, e)
          const nb = lineIndex(n.q, n.r)
          for (let ax = 0; ax < 3; ax++) {
            const d = (nb[ax] - me[ax] + mod[ax]) % mod[ax]
            if (e % 3 === ax) expect(d).toBe(0)
            else expect(d === 1 || d === mod[ax] - 1).toBe(true)
          }
        }
      }
    }
  })

  it.each([1, 2, 3])('seed %i: rings are closed, in range, and the total is even', (seed) => {
    const L = makeLines(seed)
    let total = 0
    for (const v of [L.a, L.b, L.c]) {
      for (let i = 0; i < v.length; i++) {
        total += v[i]
        expect(v[i]).toBeGreaterThanOrEqual(LINE_MIN)
        expect(v[i]).toBeLessThanOrEqual(LINE_MAX)
        expect(Math.abs(v[i] - v[(i + 1) % v.length])).toBeLessThanOrEqual(1)
      }
    }
    expect(total % 2).toBe(0)
  })

  it.each([1, 2, 3])('seed %i: the whole torus tiles with consistent polarity', (seed) => {
    const L = makeLines(seed)
    const pol = new Int8Array(GRID_SIZE * GRID_SIZE).fill(-1)
    const tile = (q: number, r: number): TileLike => {
      const [ka, kb, kc] = familyAt(L, q, r)
      return { ka, kb, kc, polarity: pol[key(q, r)] === 1 }
    }
    pol[0] = 1
    const stack = [0]
    while (stack.length) {
      const k = stack.pop()!
      const q = k >> 9, r = k & 511
      const me = tile(q, r)
      for (let e = 0; e < 6; e++) {
        const n = neighbor(q, r, e)
        const nk = key(n.q, n.r)
        const want = requiredPolarity((e + 3) % 6, familyAt(L, n.q, n.r), me) ? 1 : 0
        if (pol[nk] === -1) { pol[nk] = want; stack.push(nk) }
        else if (pol[nk] !== want) throw new Error(`polarity conflict at (${n.q},${n.r})`)
      }
    }
    expect(pol.includes(-1)).toBe(false)
  })

  it('random tap order never hits a rejected cell (edge match, polarity, delta rule)', () => {
    const L = makeLines(5)
    const tiles = new Map<number, TileLike>()
    const get = (q: number, r: number) => tiles.get(key(q, r))
    const frontier: number[] = [key(500, 3)]
    const seen = new Set(frontier)
    let s = 12345
    const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
    for (let i = 0; i < 5000; i++) {
      const j = Math.floor(rand() * frontier.length)
      const k = frontier[j]
      frontier[j] = frontier[frontier.length - 1]; frontier.pop()
      const q = k >> 9, r = k & 511
      const eps = familyAt(L, q, r)
      const res = checkNeighbors(get, q, r, eps)
      if (!res.ok) throw new Error(`(${q},${r}) rejected: ${res.reason}`)
      tiles.set(k, { ka: eps[0], kb: eps[1], kc: eps[2], polarity: res.polarity })
      for (let e = 0; e < 6; e++) {
        const n = neighbor(q, r, e)
        const nk = key(n.q, n.r)
        if (!seen.has(nk)) { seen.add(nk); frontier.push(nk) }
      }
    }
  })
})
