/**
 * Contract interaction — ABI encoding + transaction sending.
 * Uses abi.ts (no external dependencies).
 */

import {
  encode, encodeUint, encodeAddress,
  splitWords, decodeUint, decodeBool, decodeAddress,
  decodeCustomError, invertSelectors,
} from './abi'
import { GATE_ADDRESS, NFT_ADDRESS } from './config'
import { callRpc, simulateTx, rpc } from './ethrpc'
import { getRawProvider, getAddress } from './wallet'

export { callRpc, waitForReceipt } from './ethrpc'

// ── Selectors (name → 4-byte hex) ──
// Generated via: cast sig "functionName(types)"

export const SEL = {
  balanceOf:      '0x70a08231',
  getPrices:      '0xbd9a548b',
  placeTileEth:   '0xd654a0db',
  placeTileUsdc:  '0x998fb0af',
  getTile:        '0x25181bd2',
  isCatalanUsed:  '0x704a9bfe',
  readOccupancy:  '0xfcb69665',
} as const

/** Selector hex → name (derived from SEL for debug logging). */
const SEL_NAME = invertSelectors(SEL)

// ── Custom revert errors (selector → name) ──

const ERRORS: Record<string, string> = {
  '0x865c2fad': 'EpSumDeltaTooLarge',
  '0x551385bf': 'PolarityDeadCell',
  '0xa4ddfa22': 'PolarityConflict',
  '0xd97f185c': 'EdgeMismatch',
  '0xc315f899': 'CatalanIndexUsed',
  '0x485bce14': 'NotAdjacent',
  '0x0a2a4387': 'CellOccupied',
  '0x041cca20': 'InvalidEpCount',
}

function debugCall(data: string, label?: string) {
  const sel = data.slice(0, 10)
  const name = (SEL_NAME as Record<string, string>)[sel] ?? sel
  console.debug(`${label ?? 'eth_call'} ${name}`, data)
}

export async function fetchPrices(): Promise<{ eth: bigint; usdc: bigint }> {
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')
  debugCall(SEL.getPrices)
  const resultHex = await callRpc(GATE_ADDRESS, SEL.getPrices)
  const w = splitWords(resultHex)
  const eth = decodeUint(w[0])
  const usdc = decodeUint(w[1])
  console.log('fetchPrices:', { eth, usdc })
  return { eth, usdc }
}

export interface OnChainTile {
  ka: number
  kb: number
  kc: number
  polarity: boolean
  catalanIndex: bigint
  tileOwner: string
}

const zeroAddr = '0x' + '0'.repeat(40)

export async function fetchTile(q: number, r: number): Promise<OnChainTile> {
  if (!NFT_ADDRESS) throw new Error('NFT_ADDRESS not configured')
  const calldata = encode(SEL.getTile, encodeUint(q), encodeUint(r))
  debugCall(calldata)
  const resultHex = await callRpc(NFT_ADDRESS, calldata)
  const w = splitWords(resultHex)
  const tile = {
    ka: Number(decodeUint(w[0])),
    kb: Number(decodeUint(w[1])),
    kc: Number(decodeUint(w[2])),
    polarity: decodeBool(w[3]),
    catalanIndex: decodeUint(w[4]),
    tileOwner: decodeAddress(w[5]),
  }
  console.debug(`fetchTile(${q},${r}):`, tile.tileOwner === zeroAddr ? 'empty' : tile)
  return tile
}

/** Compute tokenId from grid coords (matches on-chain tokenIdOf). */
export function tokenIdOf(q: number, r: number): bigint {
  return (BigInt(q & 0x1FF) << 9n) | BigInt(r & 0x1FF)
}

export async function isCatalanUsed(ka: number, kb: number, kc: number, idx: bigint): Promise<boolean> {
  if (!NFT_ADDRESS) throw new Error('NFT_ADDRESS not configured')
  const calldata = encode(SEL.isCatalanUsed, encodeUint(ka), encodeUint(kb), encodeUint(kc), encodeUint(idx))
  debugCall(calldata)
  const resultHex = await callRpc(NFT_ADDRESS, calldata)
  const used = decodeBool(splitWords(resultHex)[0])
  console.log(`isCatalanUsed(${ka},${kb},${kc},${idx}):`, used)
  return used
}

/** Simulate then send a transaction. Returns the tx hash. */
async function sendTx(txParams: Record<string, string>): Promise<string> {
  const provider = getRawProvider()
  if (!provider) throw new Error('No wallet connected')

  debugCall(txParams.data, 'simulateTx')
  await simulateTx(txParams, msg => decodeCustomError(msg, ERRORS))

  return await rpc<string>(provider, 'eth_sendTransaction', [txParams])
}

/** Pack tile params into a single uint256 matching the contract layout:
 *  [catalanIndex 128][kc 8][kb 8][ka 8][r 16][q 16] */
function packTile(q: number, r: number, ka: number, kb: number, kc: number, catalanIndex: bigint): bigint {
  return BigInt(q) | (BigInt(r) << 16n) | (BigInt(ka) << 32n) | (BigInt(kb) << 40n) | (BigInt(kc) << 48n) | (catalanIndex << 56n)
}

/** Convert a signature (v, r, s) to EIP-2098 compact form (sigR, sigVS). */
function compactSig(v: number, r: string, s: string): { sigR: bigint; sigVS: bigint } {
  const sigR = BigInt('0x' + r.replace('0x', ''))
  const sBig = BigInt('0x' + s.replace('0x', ''))
  const sigVS = sBig | (BigInt(v - 27) << 255n)
  return { sigR, sigVS }
}

export async function placeTileEth(
  q: number,
  r: number,
  ka: number,
  kb: number,
  kc: number,
  catalanIndex: bigint
): Promise<string> {
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')
  const from = getAddress()
  if (!from) throw new Error('No account selected')

  const { eth: price } = await fetchPrices()
  const calldata = encode(
    SEL.placeTileEth,
    encodeUint(packTile(q, r, ka, kb, kc, catalanIndex)),
  )

  return sendTx({ from, to: GATE_ADDRESS, data: calldata, value: '0x' + price.toString(16) })
}

export async function placeTileUsdc(
  from: string,
  q: number,
  r: number,
  ka: number,
  kb: number,
  kc: number,
  catalanIndex: bigint,
  amount: bigint,
  validAfter: bigint,
  validBefore: bigint,
  v: number,
  authR: string,
  authS: string,
): Promise<string> {
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')

  const { sigR, sigVS } = compactSig(v, authR, authS)
  const calldata = encode(
    SEL.placeTileUsdc,
    encodeAddress(from),
    encodeUint(packTile(q, r, ka, kb, kc, catalanIndex)),
    encodeUint(amount),
    encodeUint(validAfter),
    encodeUint(validBefore),
    encodeUint(sigR),
    encodeUint(sigVS),
  )

  return sendTx({ from, to: GATE_ADDRESS, data: calldata })
}

/**
 * Batch-read repacked occupancy words from the contract.
 * @param indices Array of repacked word indices (0-1023), max 24 per call.
 * @returns Map from word index to 256-bit occupancy bigint.
 */
export async function readOccupancyWords(indices: number[]): Promise<Map<number, bigint>> {
  if (!NFT_ADDRESS) throw new Error('NFT_ADDRESS not configured')
  const result = new Map<number, bigint>()
  if (indices.length === 0) return result

  console.log(`readOccupancyWords: ${indices.length} words`)

  // Process in chunks of 24
  for (let offset = 0; offset < indices.length; offset += 24) {
    const chunk = indices.slice(offset, offset + 24)
    let packed = BigInt(chunk.length)
    for (let i = 0; i < chunk.length; i++) {
      packed |= BigInt(chunk[i] & 0x3FF) << BigInt(8 + 10 * i)
    }
    const calldata = encode(SEL.readOccupancy, encodeUint(packed))
    const resultHex = await callRpc(NFT_ADDRESS, calldata)
    // ABI decode: offset (32 bytes) + length (32 bytes) + N words
    const words = splitWords(resultHex)
    // words[0] = offset to dynamic array (0x20)
    // words[1] = array length
    const len = Number(decodeUint(words[1]))
    for (let i = 0; i < len && i < chunk.length; i++) {
      result.set(chunk[i], decodeUint(words[2 + i]))
    }
  }
  return result
}
