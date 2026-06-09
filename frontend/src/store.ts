/**
 * Store — thin state glue layer.
 * Tracks active blocks, manages RPC cache/dedup, coordinates loading, notifies frontend.
 */

import { TILE_CDN, FRONTIER_STALE_MS, SVG_MAX_CONCURRENT, PRICE_TTL_MS, POLL_INTERVAL_MS, TILE_POLL_RETRY_MS, TX_TIMEOUT_MS } from './config'
import { readOccupancyWords, fetchTile, fetchPrices as rpcFetchPrices, type OnChainTile } from './contracts'
import { neighbor } from './hex'
import {
  applyOccupancyWords, expandFrontier, hasOccupancyData,
  getUnfetchedWordIndices, getStaleFrontierIndices,
  getOccupiedCellsInBlock, getFrontierCellsInBlock,
  getOccupancyWord,
  isOccupied, getSvg, hasSvg, putSvg, putMetadata, parseSvgMetadata,
  getTile, markOccupied, markDead, blockIndex,
  type TileData,
} from './grid'
import { computeConstraintsFromNeighbors, type TileConstraints } from './tileParams'

// ── Re-exports for convenience (frontend reads from store) ──

export { isPlaced, getSvg, getTile } from './grid'

// ── Notification ──

const listeners = new Set<() => void>()
let notifyQueued = false

function notify() {
  if (!notifyQueued) {
    notifyQueued = true
    queueMicrotask(() => {
      notifyQueued = false
      for (const fn of listeners) fn()
    })
  }
}

/** Subscribe to state changes. Returns unsubscribe function. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// ── Active blocks ──

let activeBlocks = new Set<number>()

/** Set which blocks the viewport is currently showing. Triggers fetches for new blocks. */
export function setActiveBlocks(indices: Set<number>) {
  const prev = activeBlocks
  activeBlocks = indices

  // Find new blocks
  for (const wi of indices) {
    if (!prev.has(wi)) {
      activateBlock(wi)
    }
  }
}

// ── SVG loading queue (moved from grid.ts) ──

let svgInFlight = 0
const svgQueue: { q: number; r: number }[] = []
const svgQueued = new Set<string>()

function coordKey(q: number, r: number): string {
  return `${q},${r}`
}

function queueSvgLoad(q: number, r: number) {
  const k = coordKey(q, r)
  if (svgQueued.has(k) || hasSvg(q, r)) return
  svgQueued.add(k)
  svgQueue.push({ q, r })
  drainSvgQueue()
}

function drainSvgQueue() {
  while (svgInFlight < SVG_MAX_CONCURRENT && svgQueue.length > 0) {
    const { q, r } = svgQueue.shift()!
    const k = coordKey(q, r)

    if (hasSvg(q, r) || !isOccupied(q, r) || !activeBlocks.has(blockIndex(q, r))) {
      svgQueued.delete(k)
      continue
    }

    svgInFlight++
    fetch(`${TILE_CDN}/${q}/${r}.svg`)
      .then(res => {
        if (!res.ok) throw new Error('not found')
        return res.text()
      })
      .then(svgText => {
        const tile = parseSvgMetadata(svgText, q, r)
        if (tile) putMetadata(q, r, tile)

        const blob = new Blob([svgText], { type: 'image/svg+xml' })
        const url = URL.createObjectURL(blob)
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          URL.revokeObjectURL(url)
          putSvg(q, r, img)
          svgQueued.delete(k)
          svgInFlight--
          notify()
          drainSvgQueue()
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          svgQueued.delete(k)
          svgInFlight--
          drainSvgQueue()
        }
        img.src = url
      })
      .catch(() => {
        svgQueued.delete(k)
        svgInFlight--
        drainSvgQueue()
      })
  }
}

// ── RPC cache + dedup ──

const tileCache = new Map<string, OnChainTile>()
const tileInflight = new Map<string, Promise<OnChainTile>>()

let ethPrice: { value: bigint; fetchedAt: number } | null = null
let usdcPrice: { value: bigint; fetchedAt: number } | null = null
let priceInflight: Promise<{ eth: bigint | null; usdc: bigint | null }> | null = null

const constraintCache = new Map<string, TileConstraints>()


// ── Tile data (deduped + cached) ──

export async function fetchTileData(q: number, r: number): Promise<OnChainTile> {
  const k = coordKey(q, r)
  const cached = tileCache.get(k)
  if (cached) return cached

  const inflight = tileInflight.get(k)
  if (inflight) return inflight

  const promise = fetchTile(q, r).then(tile => {
    tileCache.set(k, tile)
    tileInflight.delete(k)
    notify()
    return tile
  }).catch(err => {
    tileInflight.delete(k)
    throw err
  })
  tileInflight.set(k, promise)
  return promise
}

export function getOnChainTile(q: number, r: number): OnChainTile | undefined {
  return tileCache.get(coordKey(q, r))
}

// ── Prices (deduped + TTL cached) ──

export function getEthPrice(): bigint | null {
  return ethPrice?.value ?? null
}

export function getUsdcPrice(): bigint | null {
  return usdcPrice?.value ?? null
}

export async function fetchPrices(): Promise<{ eth: bigint | null; usdc: bigint | null }> {
  const now = Date.now()
  if (ethPrice && usdcPrice && now - ethPrice.fetchedAt < PRICE_TTL_MS && now - usdcPrice.fetchedAt < PRICE_TTL_MS) {
    return { eth: ethPrice.value, usdc: usdcPrice.value }
  }

  if (priceInflight) return priceInflight

  const promise = (async () => {
    const prices = await rpcFetchPrices()
    const fetchedAt = Date.now()
    ethPrice = { value: prices.eth, fetchedAt }
    usdcPrice = { value: prices.usdc, fetchedAt }
    priceInflight = null
    notify()
    return { eth: prices.eth, usdc: prices.usdc }
  })()
  priceInflight = promise
  return promise
}

export function invalidatePrices() {
  ethPrice = null
  usdcPrice = null
  priceInflight = null
}

// ── Constraints (deduped + cached) ──

export function getConstraints(q: number, r: number): TileConstraints | undefined {
  return constraintCache.get(coordKey(q, r))
}

/** Compute constraints from SVG metadata cache. Returns null if any neighbor's metadata isn't loaded yet. */
export function computeConstraints(q: number, r: number): TileConstraints | null {
  const k = coordKey(q, r)
  const cached = constraintCache.get(k)
  if (cached) return cached

  const nbTiles: (TileData | null)[] = []
  for (let edge = 0; edge < 6; edge++) {
    const { q: nq, r: nr } = neighbor(q, r, edge)
    if (isOccupied(nq, nr)) {
      const tile = getTile(nq, nr)
      if (!tile) return null // neighbor metadata not loaded yet
      nbTiles[edge] = tile
    } else {
      nbTiles[edge] = null
    }
  }

  const constraints = computeConstraintsFromNeighbors(nbTiles)
  constraintCache.set(k, constraints)
  return constraints
}

// ── Tile selection ──

let selectedTile: { q: number; r: number } | null = null

export function getSelectedTile(): { q: number; r: number } | null {
  return selectedTile
}

export function selectTile(q: number, r: number) {
  selectedTile = { q, r }
  notify()
}

export function clearSelection() {
  selectedTile = null
  notify()
}

// ── Mutations ──

/** After mint: clear tile + neighbor constraint caches. */
export function invalidateTile(q: number, r: number) {
  const k = coordKey(q, r)
  tileCache.delete(k)
  constraintCache.delete(k)
  // Invalidate neighbor constraints too
  for (let edge = 0; edge < 6; edge++) {
    const { q: nq, r: nr } = neighbor(q, r, edge)
    constraintCache.delete(coordKey(nq, nr))
  }
}

/** Post-mint: poll CDN for SVG, cache it. */
export async function awaitTilePlacement(q: number, r: number, timeoutMs = TX_TIMEOUT_MS): Promise<boolean> {
  const k = coordKey(q, r)
  markOccupied(q, r)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${TILE_CDN}/${q}/${r}.svg`)
      if (res.ok) {
        const svgText = await res.text()
        const tile = parseSvgMetadata(svgText, q, r)
        if (tile) putMetadata(q, r, tile)

        const blob = new Blob([svgText], { type: 'image/svg+xml' })
        const url = URL.createObjectURL(blob)
        const img = new Image()
        img.crossOrigin = 'anonymous'
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject()
          img.src = url
        })
        URL.revokeObjectURL(url)
        putSvg(q, r, img)
        // Also invalidate tile data so it gets re-fetched
        tileCache.delete(k)
        notify()
        return true
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, TILE_POLL_RETRY_MS))
  }
  return false
}

// ── Constraint analysis (dead cell detection) ──

const analyzedCells = new Set<string>()

/** Analyze frontier cells for dead-ness using SVG metadata (no RPC). */
function analyzeDeadCells(cells: { q: number; r: number }[]) {
  for (const { q, r } of cells) {
    if (isOccupied(q, r)) continue
    const k = coordKey(q, r)
    if (analyzedCells.has(k)) continue

    const constraints = computeConstraints(q, r)
    if (!constraints) continue // neighbor metadata not loaded yet

    analyzedCells.add(k)
    let dead = false
    for (let axis = 0; axis < 3; axis++) {
      if (!constraints.freeAxes.has(axis) && constraints.fixed[axis] === 0) {
        dead = true
        break
      }
    }
    if (dead) {
      markDead(q, r)
      expandFrontier([blockIndex(q, r)])
    }
  }
}

// ── Block activation ──

async function activateBlock(wordIndex: number) {
  try {
    // Bootstrap: if no data at all, seed block 0
    if (!hasOccupancyData()) {
      const result = await readOccupancyWords([0])
      applyOccupancyWords(result)
      expandFrontier([0])
      notify()
    }

    // Fetch unfetched blocks
    const unfetched = getUnfetchedWordIndices(new Set([wordIndex]))
    if (unfetched.length > 0) {
      const result = await readOccupancyWords(unfetched)
      applyOccupancyWords(result)
      expandFrontier(unfetched)
      notify()
    }

    // Queue SVG loads for occupied cells
    const occupied = getOccupiedCellsInBlock(wordIndex)
    for (const { q, r } of occupied) {
      queueSvgLoad(q, r)
    }

    // Analyze frontier cells for dead-ness (sync, from SVG metadata)
    const frontier = getFrontierCellsInBlock(wordIndex)
    analyzeDeadCells(frontier)
  } catch (err) {
    console.warn('activateBlock error:', err)
  }
}

// ── Periodic re-poll (every 12s, for active blocks only) ──

setInterval(() => {
  if (activeBlocks.size === 0) return
  const now = Date.now()
  const stale = getStaleFrontierIndices(activeBlocks, now, FRONTIER_STALE_MS)
  if (stale.length === 0) return

  readOccupancyWords(stale).then(result => {
    let changed = false
    for (const [wi, word] of result) {
      if (word !== getOccupancyWord(wi)) {
        changed = true
        break
      }
    }
    applyOccupancyWords(result)
    if (changed) {
      expandFrontier(stale)
      for (const wi of stale) {
        const occupied = getOccupiedCellsInBlock(wi)
        for (const { q, r } of occupied) {
          queueSvgLoad(q, r)
        }
      }
      notify()
    }
  }).catch(err => {
    console.warn('periodic refresh error:', err)
  })
}, POLL_INTERVAL_MS)

// ── Ensure SVG loaded (called by frontend during draw) ──

/** Ensure an SVG is loading for an occupied cell. Returns cached image or undefined. */
export function ensureSvgLoaded(q: number, r: number): HTMLImageElement | undefined {
  const img = getSvg(q, r)
  if (img) return img

  // Queue fetch if occupied and not already queued
  if (isOccupied(q, r)) {
    queueSvgLoad(q, r)
  }

  return undefined
}

// ── Fetch metadata from CDN (for tile panel when SVG hasn't loaded yet) ──

export async function fetchMetadata(q: number, r: number): Promise<TileData | undefined> {
  const cached = getTile(q, r)
  if (cached) return cached

  try {
    const res = await fetch(`${TILE_CDN}/${q}/${r}.svg`)
    if (!res.ok) return undefined
    const text = await res.text()
    const tile = parseSvgMetadata(text, q, r)
    if (tile) {
      putMetadata(q, r, tile)
      return tile
    }
  } catch { /* fall through */ }
  return undefined
}
