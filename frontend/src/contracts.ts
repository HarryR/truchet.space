/**
 * Contract interaction — ABI encoding + transaction sending.
 * Uses abi.ts (no external dependencies).
 */

import {
  SEL_PRICE_ETH, SEL_PRICE_USDC, SEL_PLACE_TILE_ETH, SEL_PLACE_TILE_USDC,
  SEL_GET_TILE, SEL_IS_CATALAN_USED, SEL_READ_OCCUPANCY,
  encode, encodeUint, encodeAddress,
  splitWords, decodeUint, decodeBool, decodeAddress,
} from './abi'
import { GATE_ADDRESS, NFT_ADDRESS, RPC_URL } from './config'
import { getRawProvider, getAddress } from './wallet'

/** Selector → human-readable name for debug logging. */
const SEL_NAMES: Record<string, string> = {
  [SEL_PRICE_ETH]: 'priceETH',
  [SEL_PRICE_USDC]: 'priceUSDC',
  [SEL_GET_TILE]: 'getTile',
  [SEL_IS_CATALAN_USED]: 'isCatalanUsed',
  [SEL_READ_OCCUPANCY]: 'readOccupancy',
  [SEL_PLACE_TILE_ETH]: 'placeTileETH',
  [SEL_PLACE_TILE_USDC]: 'placeTileUSDC',
}

/** Make an eth_call using wallet provider if available, else direct RPC fetch. */
export async function callRpc(to: string, data: string): Promise<string> {
  const sel = data.slice(0, 10)
  const name = SEL_NAMES[sel] ?? sel
  console.debug(`eth_call ${name}`, data)

  const provider = getRawProvider()
  if (provider) {
    let block = 'latest'
    try {
      block = await provider.request({ method: 'eth_blockNumber' }) as string
    } catch { /* fallback */ }
    return await provider.request({
      method: 'eth_call',
      params: [{ to, data }, block],
    }) as string
  }
  if (!RPC_URL) throw new Error('No wallet and no RPC_URL configured')
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message ?? 'RPC error')
  return json.result as string
}

export async function fetchPriceETH(): Promise<bigint> {
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')
  const resultHex = await callRpc(GATE_ADDRESS, SEL_PRICE_ETH)
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
  const calldata = encode(SEL_GET_TILE, encodeUint(q), encodeUint(r))
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
  const resultHex = await callRpc(GATE_ADDRESS, SEL_PRICE_USDC)
  const price = decodeUint(splitWords(resultHex)[0])
  console.log('fetchPriceUSDC:', price)
  return price
}

export async function isCatalanUsed(ka: number, kb: number, kc: number, idx: bigint): Promise<boolean> {
  if (!NFT_ADDRESS) throw new Error('NFT_ADDRESS not configured')
  const calldata = encode(SEL_IS_CATALAN_USED, encodeUint(ka), encodeUint(kb), encodeUint(kc), encodeUint(idx))
  const resultHex = await callRpc(NFT_ADDRESS, calldata)
  const used = decodeBool(splitWords(resultHex)[0])
  console.log(`isCatalanUsed(${ka},${kb},${kc},${idx}):`, used)
  return used
}

/** Map custom error selectors to human-readable names. */
const ERROR_NAMES: Record<string, string> = {
  '0x865c2fad': 'EpSumDeltaTooLarge',
  '0x551385bf': 'PolarityDeadCell',
  '0xa4ddfa22': 'PolarityConflict',
  '0xd97f185c': 'EdgeMismatch',
  '0xc315f899': 'CatalanIndexUsed',
  '0x485bce14': 'NotAdjacent',
  '0x0a2a4387': 'CellOccupied',
  '0x041cca20': 'InvalidEpCount',
}

/** Try to decode a custom error selector from an error message or data. */
function decodeCustomError(msg: string): string {
  const match = msg.match(/0x([0-9a-f]{8})/i)
  if (match) {
    const sel = '0x' + match[1].toLowerCase()
    const name = ERROR_NAMES[sel]
    if (name) return name
  }
  return msg
}

/** Simulate a transaction via eth_call before sending. Throws with revert reason on failure. */
async function simulateTx(params: Record<string, string>): Promise<void> {
  const provider = getRawProvider()
  if (!provider) return
  const sel = params.data?.slice(0, 10) ?? '??'
  const name = SEL_NAMES[sel] ?? sel
  console.log(`simulateTx ${name}`)
  console.debug(`simulateTx ${name}`, params.data)
  let block = 'latest'
  try {
    block = await provider.request({ method: 'eth_blockNumber' }) as string
  } catch { /* fallback */ }
  try {
    await provider.request({ method: 'eth_call', params: [params, block] })
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null) {
      const obj = err as Record<string, unknown>
      const data = obj.data as Record<string, unknown> | undefined
      const rawMsg = (data?.message ?? obj.message) as string | undefined
      if (rawMsg) throw new Error(decodeCustomError(rawMsg))
    }
    throw err
  }
}

export async function placeTileETH(
  q: number,
  r: number,
  ka: number,
  kb: number,
  kc: number,
  catalanIndex: bigint
): Promise<string> {
  const provider = getRawProvider()
  if (!provider) throw new Error('No wallet connected')
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')

  const from = getAddress()
  if (!from) throw new Error('No account selected')

  const price = await fetchPriceETH()
  const calldata = encode(
    SEL_PLACE_TILE_ETH,
    encodeUint(q), encodeUint(r),
    encodeUint(ka), encodeUint(kb), encodeUint(kc),
    encodeUint(catalanIndex),
  )

  const txParams = {
    from,
    to: GATE_ADDRESS,
    data: calldata,
    value: '0x' + price.toString(16),
  }

  // Simulate first to get a readable revert reason
  await simulateTx(txParams)

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [txParams],
  }) as string

  return txHash
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
  const provider = getRawProvider()
  if (!provider) throw new Error('No wallet connected')
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')

  const calldata = encode(
    SEL_PLACE_TILE_USDC,
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

  const txParams = { from, to: GATE_ADDRESS, data: calldata }

  await simulateTx(txParams)

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [txParams],
  }) as string

  return txHash
}

export async function waitForReceipt(txHash: string, timeoutMs = 60_000): Promise<{ status: boolean }> {
  const provider = getRawProvider()
  if (!provider) throw new Error('No wallet connected')

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    }) as { status: string } | null

    if (receipt) {
      return { status: receipt.status === '0x1' }
    }

    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Transaction receipt timeout')
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
    const calldata = encode(SEL_READ_OCCUPANCY, encodeUint(packed))
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
