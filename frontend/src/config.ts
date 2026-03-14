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
  31337: 'Localhost 8545',
}

export const RPC_URL: string = import.meta.env.VITE_RPC_URL as string

// ── Contracts ──

export const USDC_ADDRESS: string = import.meta.env.VITE_USDC_ADDRESS as string
export const NFT_ADDRESS: string = import.meta.env.VITE_NFT_ADDRESS as string
export const GATE_ADDRESS: string = import.meta.env.VITE_GATE_ADDRESS as string

// ── Explorer ──

export const BLOCK_EXPLORER: string = import.meta.env.VITE_BLOCK_EXPLORER as string

// ── CDN (static tile files) ──

export const TILE_CDN: string = import.meta.env.VITE_TILE_CDN as string

// ── Occupancy polling ──

/** How long (ms) before a fetched frontier/occupied word is considered stale. */
export const FRONTIER_STALE_MS = 15_000
