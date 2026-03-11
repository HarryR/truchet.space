/**
 * Contract interaction — ABI encoding + transaction sending.
 * Uses abi.ts (no external dependencies).
 */

import {
  SEL_PRICE_ETH, SEL_PLACE_TILE_ETH, SEL_GET_TILE,
  encode, encodeUint,
  splitWords, decodeUint, decodeBool, decodeAddress,
} from './abi'
import { GATE_ADDRESS, NFT_ADDRESS } from './config'
import { getRawProvider, getAddress } from './wallet'

/** Get latest block number as hex — used as cache-buster for eth_call. */
async function latestBlock(): Promise<string> {
  const provider = getRawProvider()
  if (!provider) return 'latest'
  const hex = await provider.request({ method: 'eth_blockNumber' }) as string
  return hex
}

export async function fetchPriceETH(): Promise<bigint> {
  const provider = getRawProvider()
  if (!provider) throw new Error('No wallet connected')
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')

  const block = await latestBlock()
  const resultHex = await provider.request({
    method: 'eth_call',
    params: [{ to: GATE_ADDRESS, data: SEL_PRICE_ETH }, block],
  }) as string
  return decodeUint(splitWords(resultHex)[0])
}

export interface OnChainTile {
  ka: number
  kb: number
  kc: number
  polarity: boolean
  catalanIndex: bigint
  tileOwner: string
}

export async function fetchTile(q: number, r: number): Promise<OnChainTile> {
  const provider = getRawProvider()
  if (!provider) throw new Error('No wallet connected')
  if (!NFT_ADDRESS) throw new Error('NFT_ADDRESS not configured')

  const block = await latestBlock()
  const calldata = encode(SEL_GET_TILE, encodeUint(q), encodeUint(r))
  const resultHex = await provider.request({
    method: 'eth_call',
    params: [{ to: NFT_ADDRESS, data: calldata }, block],
  }) as string
  const w = splitWords(resultHex)
  return {
    ka: Number(decodeUint(w[0])),
    kb: Number(decodeUint(w[1])),
    kc: Number(decodeUint(w[2])),
    polarity: decodeBool(w[3]),
    catalanIndex: decodeUint(w[4]),
    tileOwner: decodeAddress(w[5]),
  }
}

/** Compute tokenId from grid coords (matches on-chain tokenIdOf). */
export function tokenIdOf(q: number, r: number): bigint {
  return (BigInt(q & 0x1FF) << 9n) | BigInt(r & 0x1FF)
}

export async function placeTile(
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

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from,
      to: GATE_ADDRESS,
      data: calldata,
      value: '0x' + price.toString(16),
    }],
  }) as string

  return txHash
}
