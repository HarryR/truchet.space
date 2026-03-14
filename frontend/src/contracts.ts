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
  priceETH:       '0xc38ad273',
  priceUSDC:      '0x998ef386',
  placeTileETH:   '0xb289fc6e',
  placeTileUSDC:  '0xc222c110',
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

export async function fetchPriceETH(): Promise<bigint> {
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')
  debugCall(SEL.priceETH)
  const resultHex = await callRpc(GATE_ADDRESS, SEL.priceETH)
  const price = decodeUint(splitWords(resultHex)[0])
  console.log('fetchPriceETH:', price)
  return price
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

export async function fetchPriceUSDC(): Promise<bigint> {
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')
  debugCall(SEL.priceUSDC)
  const resultHex = await callRpc(GATE_ADDRESS, SEL.priceUSDC)
  const price = decodeUint(splitWords(resultHex)[0])
  console.log('fetchPriceUSDC:', price)
  return price
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

export async function placeTileETH(
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

  const price = await fetchPriceETH()
  const calldata = encode(
    SEL.placeTileETH,
    encodeUint(q), encodeUint(r),
    encodeUint(ka), encodeUint(kb), encodeUint(kc),
    encodeUint(catalanIndex),
  )

  return sendTx({ from, to: GATE_ADDRESS, data: calldata, value: '0x' + price.toString(16) })
}

export async function placeTileUSDC(
  from: string,
  q: number,
  r: number,
  ka: number,
  kb: number,
  kc: number,
  catalanIndex: bigint,
  validAfter: bigint,
  validBefore: bigint,
  nonce: string,
  v: number,
  authR: string,
  authS: string,
): Promise<string> {
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')

  const calldata = encode(
    SEL.placeTileUSDC,
    encodeAddress(from),
    encodeUint(q), encodeUint(r),
    encodeUint(ka), encodeUint(kb), encodeUint(kc),
    encodeUint(catalanIndex),
    encodeUint(validAfter),
    encodeUint(validBefore),
    nonce.replace('0x', '').padStart(64, '0'),
    encodeUint(v),
    authR.replace('0x', '').padStart(64, '0'),
    authS.replace('0x', '').padStart(64, '0'),
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
