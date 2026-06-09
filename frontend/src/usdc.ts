/**
 * USDC ERC-3009 ReceiveWithAuthorization signing via EIP-712.
 */

import { USDC_ADDRESS, GATE_ADDRESS, TARGET_CHAIN_ID, USDC_AUTH_LIFETIME_S } from './config'
import { getRawProvider, getAddress } from './wallet'
import { rpc } from './ethrpc'

export interface UsdcAuthParams {
  from: string
  validAfter: bigint
  validBefore: bigint
  v: number
  r: string
  s: string
}

/** Hex-encode a byte array. */
function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}


export interface TilePlacement {
  q: number
  r: number
  ka: number
  kb: number
  kc: number
  catalanIndex: bigint
}

/**
 * Derive a nonce that cryptographically binds the USDC authorization to a
 * specific tile placement: SHA-256(q ‖ r ‖ ka ‖ kb ‖ kc ‖ catalanIndex).
 * Unique by construction — no two tiles can occupy the same cell.
 */
async function deriveNonce(tile: TilePlacement): Promise<string> {
  const buf = new ArrayBuffer(23) // 2+2+1+1+1+16
  const view = new DataView(buf)
  view.setUint16(0, tile.q)
  view.setUint16(2, tile.r)
  view.setUint8(4, tile.ka)
  view.setUint8(5, tile.kb)
  view.setUint8(6, tile.kc)
  // catalanIndex as 128-bit big-endian
  view.setBigUint64(7, tile.catalanIndex >> 64n)
  view.setBigUint64(15, tile.catalanIndex & 0xffffffffffffffffn)

  const hash = await crypto.subtle.digest('SHA-256', buf)
  return toHex(new Uint8Array(hash))
}

/**
 * Sign a USDC ReceiveWithAuthorization (ERC-3009) via EIP-712 typed data.
 * The nonce is derived from the tile placement params so the authorization
 * is cryptographically bound to this specific mint.
 */
export async function signUsdcAuthorization(value: bigint, tile: TilePlacement): Promise<UsdcAuthParams> {
  const provider = getRawProvider()
  if (!provider) throw new Error('No wallet connected')
  const from = getAddress()
  if (!from) throw new Error('No account selected')
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')
  if (!USDC_ADDRESS) throw new Error('USDC_ADDRESS not configured')

  const nonce = await deriveNonce(tile)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const validAfter = 0n
  const validBefore = now + BigInt(USDC_AUTH_LIFETIME_S)

  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization',
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: TARGET_CHAIN_ID,
      verifyingContract: USDC_ADDRESS,
    },
    message: {
      from,
      to: GATE_ADDRESS,
      value: '0x' + value.toString(16),
      validAfter: '0x0',
      validBefore: '0x' + validBefore.toString(16),
      nonce,
    },
  }

  const sig = await rpc<string>(provider, 'eth_signTypedData_v4', [from, JSON.stringify(typedData)])

  // Split signature: r = bytes 0-32, s = bytes 32-64, v = byte 64
  const raw = sig.replace('0x', '')
  const r = '0x' + raw.slice(0, 64)
  const s = '0x' + raw.slice(64, 128)
  const v = parseInt(raw.slice(128, 130), 16)

  return { from, validAfter, validBefore, v, r, s }
}
