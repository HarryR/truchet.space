/**
 * Wallet connection state — vanilla TS, no framework dependency.
 * Uses EIP-6963 discovery and raw EIP-1193 provider calls.
 */

import { type EIP1193Provider, startDiscovery, getProvider, getProviders } from './eip6963'
import {
  SEL_BALANCE_OF, encode, encodeAddress,
  splitWords, decodeUint, formatEther, formatUnits,
} from './abi'
import {
  TARGET_CHAIN_ID,
  TARGET_CHAIN_ID_HEX,
  CHAIN_NAMES,
  RPC_URL,
  USDC_ADDRESS,
} from './config'

export { TARGET_CHAIN_ID, TARGET_CHAIN_ID_HEX }

export function getChainName(id: number | null): string {
  if (id === null) return 'Unknown'
  return CHAIN_NAMES[id] ?? `Chain ${id}`
}

// ── State ──

let address: string | null = null
let chainId: number | null = null
let currentProvider: EIP1193Provider | null = null
let ethBalance: string | null = null
let usdcBalance: string | null = null
let activeRdns: string | null = null

/** All accounts we've seen per provider rdns. */
const accountsByRdns = new Map<string, string[]>()

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
  for (const fn of listeners) fn()
}

// ── Public getters ──

export function getAddress(): string | null { return address }
export function getChainId(): number | null { return chainId }
export function getEthBalance(): string | null { return ethBalance }
export function getUsdcBalance(): string | null { return usdcBalance }
export function getActiveRdns(): string | null { return activeRdns }
export function isConnected(): boolean { return address !== null }
export function isCorrectChain(): boolean { return chainId === TARGET_CHAIN_ID }

/** Get all known accounts for a given provider rdns. */
export function getAccountsForProvider(rdns: string): string[] {
  return accountsByRdns.get(rdns) ?? []
}

/** Subscribe to state changes. Returns unsubscribe function. */
export function onChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ── Helpers ──

/** Find the rdns for a provider by reference equality against discovered EIP-6963 providers. */
function findRdns(provider: EIP1193Provider): string | null {
  for (const detail of getProviders()) {
    if (detail.provider === provider) return detail.info.rdns
  }
  return null
}

// ── Event handlers ──

function handleAccountsChanged(accounts: unknown) {
  const accts = accounts as string[]
  if (accts.length === 0) {
    disconnect()
  } else {
    if (activeRdns) accountsByRdns.set(activeRdns, accts)
    // Always respect the wallet's selection — accts[0] is the active account
    address = accts[0]
    fetchBalances()
    notify()
  }
}

function handleChainChanged(chainIdHex: unknown) {
  chainId = parseInt(chainIdHex as string, 16)
  fetchBalances()
  notify()
}

function handleDisconnect() {
  disconnect()
}

function setupListeners(provider: EIP1193Provider) {
  provider.on?.('accountsChanged', handleAccountsChanged)
  provider.on?.('chainChanged', handleChainChanged)
  provider.on?.('disconnect', handleDisconnect)
}

function removeListeners(provider: EIP1193Provider) {
  provider.removeListener?.('accountsChanged', handleAccountsChanged)
  provider.removeListener?.('chainChanged', handleChainChanged)
  provider.removeListener?.('disconnect', handleDisconnect)
}

// ── Actions ──

export async function connect(rdns?: string): Promise<boolean> {
  const provider = getProvider(rdns)
  if (!provider) throw new Error('No wallet provider found')

  const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[]
  if (accounts.length === 0) throw new Error('No accounts available')

  // eth_accounts returns all permitted accounts, not just the selected one
  const allAccounts = await provider.request({ method: 'eth_accounts' }) as string[]
  const hex = await provider.request({ method: 'eth_chainId' }) as string

  if (currentProvider) removeListeners(currentProvider)
  currentProvider = provider
  address = accounts[0]
  chainId = parseInt(hex, 16)
  activeRdns = rdns ?? findRdns(provider)
  if (activeRdns) accountsByRdns.set(activeRdns, allAccounts.length > 0 ? allAccounts : accounts)
  setupListeners(provider)
  fetchBalances()
  notify()
  return true
}

/** Select a specific account on the current provider. No RPC needed — app-level switch. */
export function selectAccount(addr: string) {
  if (!currentProvider || !activeRdns) return
  const accounts = accountsByRdns.get(activeRdns)
  if (!accounts?.includes(addr)) return
  address = addr
  ethBalance = null
  usdcBalance = null
  fetchBalances()
  notify()
}

export function disconnect() {
  if (currentProvider) {
    removeListeners(currentProvider)
    currentProvider = null
  }
  if (activeRdns) accountsByRdns.delete(activeRdns)
  address = null
  chainId = null
  ethBalance = null
  usdcBalance = null
  activeRdns = null
  notify()
}

// ── Balance fetching ──

async function fetchBalances() {
  if (!currentProvider || !address) return
  const addr = address

  // Use eth_blockNumber as cache-buster (MetaMask caches 'latest' aggressively)
  let block = 'latest'
  try {
    block = await currentProvider.request({ method: 'eth_blockNumber' }) as string
  } catch { /* fall back to 'latest' */ }

  try {
    const ethHex = await currentProvider.request({
      method: 'eth_getBalance',
      params: [addr, block],
    }) as string
    if (address !== addr) return
    ethBalance = formatEther(BigInt(ethHex))
  } catch {
    ethBalance = null
  }

  try {
    const calldata = encode(SEL_BALANCE_OF, encodeAddress(addr))
    const resultHex = await currentProvider.request({
      method: 'eth_call',
      params: [{ to: USDC_ADDRESS, data: calldata }, block],
    }) as string
    if (address !== addr) return
    const words = splitWords(resultHex)
    usdcBalance = formatUnits(decodeUint(words[0]), 6)
  } catch {
    usdcBalance = null
  }

  notify()
}

export async function checkExisting(): Promise<boolean> {
  try {
    const provider = getProvider()
    if (!provider) return false

    const accounts = await provider.request({ method: 'eth_accounts' }) as string[]
    if (accounts.length === 0) return false

    const hex = await provider.request({ method: 'eth_chainId' }) as string
    currentProvider = provider
    address = accounts[0]
    chainId = parseInt(hex, 16)
    activeRdns = findRdns(provider)
    if (activeRdns) accountsByRdns.set(activeRdns, accounts)
    setupListeners(provider)
    fetchBalances()
    notify()
    return true
  } catch {
    return false
  }
}

async function addChain(chainIdHex: string): Promise<boolean> {
  if (!currentProvider) return false
  // 31337 is registered as "GoChain Testnet" on chainlist.org — MetaMask validates against this.
  const chainId = parseInt(chainIdHex, 16)
  const name = chainId === 31337 ? 'GoChain Testnet' : (CHAIN_NAMES[chainId] ?? `Chain ${chainIdHex}`)
  const rpcUrl = RPC_URL || (chainIdHex === '0x7a69' ? 'http://127.0.0.1:8545' : '')
  if (!rpcUrl) return false
  try {
    await currentProvider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: chainIdHex,
        chainName: name,
        nativeCurrency: chainId === 31337
          ? { name: 'GoChain Ether', symbol: 'GO', decimals: 18 }
          : { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [rpcUrl],
      }],
    })
    return true
  } catch {
    return false
  }
}

export async function switchChain(chainIdHex: string): Promise<boolean> {
  if (!currentProvider) return false
  try {
    await currentProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    })
    return true
  } catch (err: unknown) {
    // 4902 = chain not added to wallet yet — try adding it
    const code = (err as { code?: number }).code
    if (code === 4902) {
      return addChain(chainIdHex)
    }
    return false
  }
}

/** Prompt the user to switch to the target chain. */
export async function ensureCorrectChain(): Promise<boolean> {
  if (isCorrectChain()) return true
  return switchChain(TARGET_CHAIN_ID_HEX)
}

/** Get the raw EIP-1193 provider (for sending transactions etc.). */
export function getRawProvider(): EIP1193Provider | null {
  return currentProvider
}

export { getProviders, startDiscovery }

// Start discovery immediately on import
startDiscovery()
