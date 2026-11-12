/** Catalan numbers C(0)..C(64): the number of distinct tiles in a family with n arcs. */
const CATALAN: bigint[] = [1n]
for (let i = 1; i <= 64; i++) {
  CATALAN[i] = CATALAN[i - 1] * BigInt(2 * (2 * i - 1)) / BigInt(i + 1)
}

/** Catalan(n), or 0 if out of range. */
export function catalan(n: number): bigint {
  if (n < 0 || n >= CATALAN.length) return 0n
  return CATALAN[n]
}

/** Uniform-ish random bigint in [0, max). Bias is negligible for max ≪ 2^128. */
export function randomBelow(max: bigint, rand: () => number = Math.random): bigint {
  if (max <= 0n) throw new Error('randomBelow: max must be positive')
  if (max <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return BigInt(Math.floor(rand() * Number(max)))
  }
  let v = 0n
  for (let i = 0; i < 5; i++) {
    v = (v << 32n) | BigInt(Math.floor(rand() * 0x1_0000_0000))
  }
  return v % max
}
