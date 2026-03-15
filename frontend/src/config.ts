/**
 * Environment-dependent configuration.
 * All tunables that may vary between dev / staging / prod live here.
 * Set via Vite env vars (VITE_*) in .env.local or CI.
 *
 * Required vars are validated at build time by the envCheck plugin
 * in vite.config.ts — the build fails if any are missing.
 */

// ── Network ──

export const TARGET_CHAIN_ID: number =
  Number(import.meta.env.VITE_CHAIN_ID)

export const TARGET_CHAIN_ID_HEX: string =
  '0x' + TARGET_CHAIN_ID.toString(16)

export const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  11155111: 'Sepolia',
  10: 'Optimism',
  8453: 'Base',
  42161: 'Arbitrum',
  137: 'Polygon',
  31337: 'GoChain Testnet',
}

export const NATIVE_CURRENCY: Record<number, { name: string; symbol: string; decimals: number }> = {
  31337: { name: 'GoChain Ether', symbol: 'GO', decimals: 18 },
}

const DEFAULT_CURRENCY = { name: 'Ether', symbol: 'ETH', decimals: 18 }

export function nativeCurrency(chainId: number) {
  return NATIVE_CURRENCY[chainId] ?? DEFAULT_CURRENCY
}

/** Raw env value — may be comma-separated list of RPC URLs. */
const RPC_URL_RAW: string = import.meta.env.VITE_RPC_URL as string

/** Parsed RPC URLs (split on comma, trimmed, empty entries dropped). */
export const RPC_URLS: string[] = (RPC_URL_RAW ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)


// ── Contracts ──

export const USDC_ADDRESS: string = import.meta.env.VITE_USDC_ADDRESS as string
export const NFT_ADDRESS: string = import.meta.env.VITE_NFT_ADDRESS as string
export const GATE_ADDRESS: string = import.meta.env.VITE_GATE_ADDRESS as string

// ── Explorer ──

export const BLOCK_EXPLORER: string = import.meta.env.VITE_BLOCK_EXPLORER as string

// ── CDN (static tile files) ──

export const TILE_CDN: string = import.meta.env.VITE_TILE_CDN as string

// ── RPC pool ──

export const RPC_TIMEOUT_MS = 3_000
export const RPC_MIN_PRIORITY = 0.01
export const RPC_MAX_PRIORITY = 1.1
export const RPC_DEMOTE_FACTOR = 0.5
export const RPC_PROMOTE_FACTOR = 1.2

// ── Grid ──

// XXX: please never change this, it will cause huge fuckups
export const GRID_SIZE = 512

// ── Occupancy polling ──

const ETH_BLOCK_TIME_MS = 12_000

/** How long (ms) before a fetched frontier/occupied word is considered stale. */
export const FRONTIER_STALE_MS = 2*ETH_BLOCK_TIME_MS

/** How often (ms) to re-poll active blocks for new placements. */
export const POLL_INTERVAL_MS = ETH_BLOCK_TIME_MS

/** Retry interval (ms) when polling CDN for a newly-minted tile's SVG. */
export const TILE_POLL_RETRY_MS = ETH_BLOCK_TIME_MS

/** Timeout (ms) for waiting on transaction receipt or tile placement. */
export const TX_TIMEOUT_MS = 6*ETH_BLOCK_TIME_MS

/** Retry interval (ms) when polling for a transaction receipt. */
export const TX_POLL_RETRY_MS = ETH_BLOCK_TIME_MS/2

// ── SVG loading ──

/** Max concurrent SVG fetches from CDN. */
export const SVG_MAX_CONCURRENT = 10

/** Max visible cells at minimum zoom (controls minZoom calculation). */
export const MAX_VISIBLE_CELLS = 2500

/** Max SVG images to keep in the LRU cache. Must be >= MAX_VISIBLE_CELLS to avoid thrashing. */
export const SVG_CACHE_MAX = MAX_VISIBLE_CELLS*1.5

// ── Interaction ──

/** Debounce delay (ms) after pan/zoom/resize before updating active blocks. */
export const VIEWPORT_DEBOUNCE_MS = 500

// ── Tile parameters ──

/** Min allowed EP sum (ka+kb+kc). */
export const EP_SUM_MIN = 3

/** Max allowed EP sum (ka+kb+kc). */
export const EP_SUM_MAX = 64

/** Max attempts when picking a random unused Catalan index. */
export const CATALAN_PICK_ATTEMPTS = 10

// ── USDC authorization ──

/** How long (seconds) a signed USDC ReceiveWithAuthorization remains valid. */
export const USDC_AUTH_LIFETIME_S = 600 // 10 minutes

// ── Price caching ──

/** How long (ms) before cached ETH/USDC prices are considered stale. */
export const PRICE_TTL_MS = 6*ETH_BLOCK_TIME_MS
