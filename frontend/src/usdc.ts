/**
 * USDC ERC-3009 ReceiveWithAuthorization signing via EIP-712.
 */

import { USDC_ADDRESS, GATE_ADDRESS, TARGET_CHAIN_ID } from './config'
import { getRawProvider, getAddress } from './wallet'
import { rpc } from './ethrpc'

export interface UsdcAuthParams {
  from: string
  validAfter: bigint
  validBefore: bigint
  nonce: string
  v: number
  r: string
  s: string
}

/** Generate a random 32-byte nonce as hex string. */
function randomNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Sign a USDC ReceiveWithAuthorization (ERC-3009) via EIP-712 typed data.
 * Returns all params needed for placeTileUSDC.
 */
export async function signUsdcAuthorization(value: bigint): Promise<UsdcAuthParams> {
  const provider = getRawProvider()
  if (!provider) throw new Error('No wallet connected')
  const from = getAddress()
  if (!from) throw new Error('No account selected')
  if (!GATE_ADDRESS) throw new Error('GATE_ADDRESS not configured')
  if (!USDC_ADDRESS) throw new Error('USDC_ADDRESS not configured')

  const nonce = randomNonce()
  const validAfter = 0n
  const validBefore = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')

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

  return { from, validAfter, validBefore, nonce, v, r, s }
}
