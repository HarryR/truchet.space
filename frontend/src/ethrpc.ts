/**
 * Weighted RPC pool with retry on failure.
 *
 * Distributes eth_call load across multiple RPC endpoints.
 * Endpoints are chosen by weighted random selection. On success the
 * weight is bumped; on failure (HTTP 429/403, timeout, non-JSON-RPC
 * response) it is demoted. Failed requests are retried on a different
 * endpoint.
 */

import {
  RPC_URLS, RPC_TIMEOUT_MS,
  RPC_MIN_PRIORITY, RPC_MAX_PRIORITY,
  RPC_DEMOTE_FACTOR, RPC_PROMOTE_FACTOR,
  TX_TIMEOUT_MS, TX_POLL_RETRY_MS,
} from './config'
import { getRawProvider } from './wallet'

// ── Pool state ──

interface RpcEndpoint {
  url: string
  priority: number
}

const rpcPool: RpcEndpoint[] = RPC_URLS.map(url => ({ url, priority: 1.0 }))

function pickEndpoint(exclude?: RpcEndpoint): RpcEndpoint | undefined {
  const candidates = exclude ? rpcPool.filter(e => e !== exclude) : rpcPool
  if (candidates.length === 0) return exclude // last resort: retry same one
  const total = candidates.reduce((s, e) => s + e.priority, 0)
  let r = Math.random() * total
  for (const ep of candidates) {
    r -= ep.priority
    if (r <= 0) return ep
  }
  return candidates[candidates.length - 1]
}

function demote(ep: RpcEndpoint) {
  ep.priority = Math.max(RPC_MIN_PRIORITY, ep.priority * RPC_DEMOTE_FACTOR)
}

function promote(ep: RpcEndpoint) {
  ep.priority = Math.min(RPC_MAX_PRIORITY, ep.priority * RPC_PROMOTE_FACTOR)
}

// ── Single-endpoint fetch ──

async function rpcFetch(ep: RpcEndpoint, to: string, data: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    })
    if (res.status === 429 || res.status === 403 || !res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const json = await res.json()
    if (json.error) throw new Error(json.error.message ?? 'RPC error')
    return json.result as string
  } finally {
    clearTimeout(timer)
  }
}

// ── Provider helpers ──

/** Get the latest block number from the wallet provider (cache-buster for MetaMask). */
export async function providerBlock(): Promise<string> {
  const provider = getRawProvider()
  if (!provider) return 'latest'
  try {
    return await rpc<string>(provider, 'eth_blockNumber')
  } catch {
    return 'latest'
  }
}

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

/** Send a JSON-RPC request to a provider. */
export function rpc<T = unknown>(provider: Provider, method: string, params?: unknown[]): Promise<T> {
  return provider.request({ method, params }) as Promise<T>
}

/** Request wallet accounts (prompts user). */
export function requestAccounts(provider: Provider) {
  return rpc<string[]>(provider, 'eth_requestAccounts')
}

/** Get already-permitted accounts (no prompt). */
export function getAccounts(provider: Provider) {
  return rpc<string[]>(provider, 'eth_accounts')
}

/** Parse a hex chain ID string to a number. */
export function parseChainId(hex: string): number {
  return parseInt(hex, 16)
}

/** Fetch the chain ID from a provider, returned as a number. */
export async function fetchChainId(provider: Provider): Promise<number> {
  return parseChainId(await rpc<string>(provider, 'eth_chainId'))
}

// ── Public API ──

/** Make an eth_call via wallet provider (if available) or the RPC pool with retry. */
export async function callRpc(to: string, data: string): Promise<string> {
  const provider = getRawProvider()
  if (provider) {
    const block = await providerBlock()
    return await rpc<string>(provider, 'eth_call', [{ to, data }, block])
  }

  if (rpcPool.length === 0) throw new Error('No wallet and no RPC_URL configured')

  const maxAttempts = Math.min(rpcPool.length, 3)
  let lastErr: Error | undefined
  let lastEp: RpcEndpoint | undefined
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ep = pickEndpoint(lastEp)
    if (!ep) break
    lastEp = ep
    try {
      const result = await rpcFetch(ep, to, data)
      promote(ep)
      return result
    } catch (err) {
      demote(ep)
      lastErr = err instanceof Error ? err : new Error(String(err))
      console.debug(`RPC ${ep.url} failed (pri=${ep.priority.toFixed(3)}):`, lastErr.message)
    }
  }
  throw lastErr ?? new Error('All RPC endpoints failed')
}

/** Simulate a transaction via eth_call before sending. Throws with revert reason on failure. */
export async function simulateTx(
  params: Record<string, string>,
  decodeError: (msg: string) => string,
): Promise<void> {
  const provider = getRawProvider()
  if (!provider) return
  const block = await providerBlock()
  try {
    await rpc(provider, 'eth_call', [params, block])
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null) {
      const obj = err as Record<string, unknown>
      const data = obj.data as Record<string, unknown> | undefined
      const rawMsg = (data?.message ?? obj.message) as string | undefined
      if (rawMsg) throw new Error(decodeError(rawMsg))
    }
    throw err
  }
}

/** Poll for a transaction receipt until confirmed or timeout. */
export async function waitForReceipt(txHash: string, timeoutMs = TX_TIMEOUT_MS): Promise<{ status: boolean }> {
  const provider = getRawProvider()
  if (!provider) throw new Error('No wallet connected')

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const receipt = await rpc<{ status: string } | null>(provider, 'eth_getTransactionReceipt', [txHash])

    if (receipt) {
      return { status: receipt.status === '0x1' }
    }

    await new Promise(r => setTimeout(r, TX_POLL_RETRY_MS))
  }
  throw new Error('Transaction receipt timeout')
}
