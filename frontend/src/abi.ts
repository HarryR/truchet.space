/**
 * Minimal ABI encoding/decoding for fixed-size Solidity types.
 * Replaces `ox` — no dependencies, no keccak, no sha3.
 *
 * All function selectors are precomputed constants.
 */

// ── Precomputed 4-byte selectors ──
// keccak256("balanceOf(address)")            = 0x70a08231
// keccak256("priceETH()")                    = 0xf35e4a6e
// keccak256("placeTileETH(uint32,uint32,uint8,uint8,uint8,uint128)") = see below
// keccak256("getTile(uint32,uint32)")        = see below
//
// Generated once via: cast sig "functionName(types)"

export const SEL_BALANCE_OF = '0x70a08231'
export const SEL_PRICE_ETH = '0xc38ad273'
export const SEL_PLACE_TILE_ETH = '0xb289fc6e'
export const SEL_GET_TILE = '0x25181bd2'

// ── Encoding helpers ──

/** Left-pad a hex string (no 0x prefix) to 64 chars (32 bytes). */
function pad32(hex: string): string {
  return hex.padStart(64, '0')
}

/** Encode a uint (number or bigint) as a 32-byte ABI word. */
export function encodeUint(v: number | bigint): string {
  return pad32(BigInt(v).toString(16))
}

/** Encode an address as a 32-byte ABI word. */
export function encodeAddress(addr: string): string {
  return pad32(addr.replace('0x', '').toLowerCase())
}

/** Build calldata: selector + encoded args. */
export function encode(selector: string, ...words: string[]): string {
  return selector + words.join('')
}

// ── Decoding helpers ──

/** Decode a uint256 from a 32-byte hex word. */
export function decodeUint(word: string): bigint {
  return BigInt('0x' + word)
}

/** Decode a bool from a 32-byte hex word. */
export function decodeBool(word: string): boolean {
  return word[63] !== '0'
}

/** Decode an address from a 32-byte hex word. */
export function decodeAddress(word: string): string {
  return '0x' + word.slice(24)
}

/** Split hex return data (without 0x) into 32-byte words. */
export function splitWords(hex: string): string[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const words: string[] = []
  for (let i = 0; i < clean.length; i += 64) {
    words.push(clean.slice(i, i + 64))
  }
  return words
}

// ── Value formatting ──

const TEN = 10n

/** Format a bigint wei value as a decimal ETH string. */
export function formatEther(wei: bigint): string {
  return formatUnits(wei, 18)
}

/** Format a bigint value with the given number of decimals. */
export function formatUnits(value: bigint, decimals: number): string {
  const divisor = TEN ** BigInt(decimals)
  const whole = value / divisor
  const frac = value % divisor
  if (frac === 0n) return whole.toString()
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}.${fracStr}`
}
