/**
 * Grid state — on-chain bitmap occupancy, LRU SVG cache, on-demand JSON metadata.
 *
 * Three-layer architecture:
 * 1. Occupancy layer — read on-chain bitmap to know which cells are placed.
 * 2. Rendering layer — fetch SVGs/metadata only for occupied cells.
 * 3. Constraint layer — mark unplaceable frontier cells as dead.
 */

import { TILE_CDN } from './config'
import { readOccupancyWords } from './contracts'
import { computeConstraints } from './tileParams'
import { GRID_SIZE, MASK, neighbors } from './hex'

export interface TileData {
  q: number
  r: number
  ka: number
  kb: number
  kc: number
  catalanIndex: bigint
  minter?: string
}

// ── Layer 1: Occupancy cache ──

/** Repacked occupancy words: wordIndex (0-1023) → 256-bit occupancy. */
const occCache = new Map<number, bigint>()

/** Frontier watch set: repacked word indices containing unresolved frontier cells. */
const frontierWords = new Set<number>()

function tokenId(q: number, r: number): number {
  return ((q & MASK) << 9) | (r & MASK)
}

/** Check if a cell is occupied (placed tile or marked dead). */
export function isOccupied(q: number, r: number): boolean {
  const id = tokenId(q, r)
  const wordIndex = id >> 8
  const bit = id & 255
  const word = occCache.get(wordIndex)
  if (word === undefined) return false
  return (word & (1n << BigInt(bit))) !== 0n
}

/** Alias for backward compatibility — true if occupied on-chain. */
export function isPlaced(q: number, r: number): boolean {
  return isOccupied(q, r)
}

/** Mark a cell as dead (unplaceable) in the local occupancy cache. */
export function markDead(q: number, r: number) {
  const id = tokenId(q, r)
  const wordIndex = id >> 8
  const bit = id & 255
  const word = occCache.get(wordIndex) ?? 0n
  occCache.set(wordIndex, word | (1n << BigInt(bit)))
}

/** Set a cell as occupied in the local cache (e.g. after minting). */
export function markOccupied(q: number, r: number) {
  const id = tokenId(q, r)
  const wordIndex = id >> 8
  const bit = id & 255
  const word = occCache.get(wordIndex) ?? 0n
  occCache.set(wordIndex, word | (1n << BigInt(bit)))
}

// ── Frontier tracking ──

function updateFrontier(wordIndices: Iterable<number>) {
  for (const wi of wordIndices) {
    const word = occCache.get(wi) ?? 0n
    if (word === 0n) continue

    let hasFrontier = false
    // Scan placed cells in this word, check their neighbors
    const base = wi << 8
    for (let bit = 0; bit < 256; bit++) {
      if ((word & (1n << BigInt(bit))) === 0n) continue
      const id = base + bit
      const q = (id >> 9) & MASK
      const r = id & MASK
      for (const { q: nq, r: nr } of neighbors(q, r)) {
        if (!isOccupied(nq, nr)) {
          const nWordIndex = tokenId(nq, nr) >> 8
          frontierWords.add(nWordIndex)
          hasFrontier = true
        }
      }
    }
    if (!hasFrontier) {
      frontierWords.delete(wi)
    }
  }
}

let refreshInProgress = false

/**
 * Fetch occupancy bitmap for the visible viewport range.
 * Debounce externally — this just does the work.
 */
export async function refreshBitmap(qMin: number, qMax: number, rMin: number, rMax: number) {
  if (refreshInProgress) return
  refreshInProgress = true
  try {
    // Compute repacked word indices for visible cells
    const needed = new Set<number>()
    for (let q = qMin; q <= qMax; q++) {
      const wq = ((q % GRID_SIZE) + GRID_SIZE) & MASK
      for (let r = rMin; r <= rMax; r++) {
        const wr = ((r % GRID_SIZE) + GRID_SIZE) & MASK
        const id = (wq << 9) | wr
        needed.add(id >> 8)
      }
    }

    // Filter out already-cached words
    const toFetch: number[] = []
    for (const wi of needed) {
      if (!occCache.has(wi)) toFetch.push(wi)
    }

    if (toFetch.length > 0) {
      const result = await readOccupancyWords(toFetch)
      for (const [wi, word] of result) {
        occCache.set(wi, word)
      }
      updateFrontier(toFetch)
      scheduleRedraw()
    }
  } catch (err) {
    console.warn('refreshBitmap error:', err)
  } finally {
    refreshInProgress = false
  }
}

/** Re-fetch frontier words from chain. Call periodically. */
export async function refreshFrontier() {
  if (frontierWords.size === 0) return
  const indices = [...frontierWords]
  try {
    const result = await readOccupancyWords(indices)
    let changed = false
    for (const [wi, word] of result) {
      const old = occCache.get(wi) ?? 0n
      if (word !== old) {
        occCache.set(wi, word)
        changed = true
      }
    }
    if (changed) {
      updateFrontier(indices)
      scheduleRedraw()
    }
  } catch (err) {
    console.warn('refreshFrontier error:', err)
  }
}

// ── Layer 3: Constraint analysis (dead cell detection) ──

const analyzedCells = new Set<string>()
let analyzeQueue: { q: number; r: number }[] = []
let analyzeRunning = false

function coordKey(q: number, r: number): string {
  return `${q},${r}`
}

/** Queue frontier cells for constraint analysis. */
export function queueConstraintAnalysis(qMin: number, qMax: number, rMin: number, rMax: number) {
  for (let q = qMin; q <= qMax; q++) {
    const wq = ((q % GRID_SIZE) + GRID_SIZE) & MASK
    for (let r = rMin; r <= rMax; r++) {
      const wr = ((r % GRID_SIZE) + GRID_SIZE) & MASK
      if (isOccupied(wq, wr)) continue
      const k = coordKey(wq, wr)
      if (analyzedCells.has(k)) continue

      // Check if adjacent to a placed tile
      let adjacent = false
      for (const { q: nq, r: nr } of neighbors(wq, wr)) {
        if (isOccupied(nq, nr)) { adjacent = true; break }
      }
      if (!adjacent) continue

      analyzedCells.add(k)
      analyzeQueue.push({ q: wq, r: wr })
    }
  }
  drainAnalyzeQueue()
}

async function drainAnalyzeQueue() {
  if (analyzeRunning) return
  analyzeRunning = true
  while (analyzeQueue.length > 0) {
    const { q, r } = analyzeQueue.shift()!
    // Re-check — may have been placed since queued
    if (isOccupied(q, r)) continue
    try {
      const constraints = await computeConstraints(q, r)
      // If all axes are constrained and any has EP=0, or constraint check itself
      // finds no valid config, this is dead. computeConstraints currently doesn't
      // throw on dead cells, so we check: if any fixed axis is 0, it's dead
      // (ka/kb/kc must all be >= 1).
      let dead = false
      for (let axis = 0; axis < 3; axis++) {
        if (!constraints.freeAxes.has(axis) && constraints.fixed[axis] === 0) {
          dead = true
          break
        }
      }
      if (dead) {
        markDead(q, r)
        // Re-evaluate frontier
        const wi = tokenId(q, r) >> 8
        updateFrontier([wi])
      }
    } catch {
      // Can't analyze yet — will retry on future viewport/frontier refresh
    }
  }
  analyzeRunning = false
}

// ── Metadata (extracted from SVG <metadata> on load) ──

const metadataCache = new Map<string, TileData>()

function key(q: number, r: number): string {
  return `${q},${r}`
}

/** Parse metadata JSON from SVG text. Format: <metadata>{...}</metadata> */
function parseSvgMetadata(svgText: string, q: number, r: number): TileData | undefined {
  const start = svgText.indexOf('<metadata>')
  const end = svgText.indexOf('</metadata>')
  if (start < 0 || end < 0) return undefined
  try {
    const json = JSON.parse(svgText.slice(start + 10, end))
    const eps = json.config?.eps as number[] | undefined
    if (!eps || eps.length !== 3) return undefined
    const [ka, kb, kc] = eps
    // tiles[0][0] is the catalan index as a string
    const catalanIndex = BigInt(json.tiles?.[0]?.[0] ?? '0')
    const minter = json.minter as string | undefined
    return { q, r, ka, kb, kc, catalanIndex, minter }
  } catch {
    return undefined
  }
}

export function getTile(q: number, r: number): TileData | undefined {
  return metadataCache.get(key(q, r))
}

/**
 * Returns cached metadata if available (populated automatically from SVG loads).
 * Falls back to JSON endpoint if SVG hasn't been loaded yet.
 */
export async function fetchMetadata(q: number, r: number): Promise<TileData | undefined> {
  const k = key(q, r)
  const cached = metadataCache.get(k)
  if (cached) return cached

  // Try fetching SVG as text to extract embedded metadata
  try {
    const res = await fetch(`${TILE_CDN}/${q}/${r}.svg`)
    if (!res.ok) return undefined
    const text = await res.text()
    const tile = parseSvgMetadata(text, q, r)
    if (tile) {
      metadataCache.set(k, tile)
      return tile
    }
  } catch { /* fall through */ }
  return undefined
}

// ── LRU SVG cache (max 500 images) ──

const SVG_CACHE_MAX = 500
const svgCache = new Map<string, HTMLImageElement>()

function touchCache(k: string, img: HTMLImageElement) {
  svgCache.delete(k)
  svgCache.set(k, img)
}

function evictCache() {
  while (svgCache.size > SVG_CACHE_MAX) {
    const oldest = svgCache.keys().next().value!
    svgCache.delete(oldest)
  }
}

// ── Lazy SVG loading with concurrency cap ──

const MAX_CONCURRENT = 20
let inFlight = 0
const loadQueue: { q: number; r: number }[] = []
const queued = new Set<string>()

let onUpdate: (() => void) | null = null
let redrawScheduled = false

export function setOnUpdate(cb: () => void) {
  onUpdate = cb
}

function scheduleRedraw() {
  if (!redrawScheduled) {
    redrawScheduled = true
    requestAnimationFrame(() => {
      redrawScheduled = false
      onUpdate?.()
    })
  }
}

function drainQueue() {
  while (inFlight < MAX_CONCURRENT && loadQueue.length > 0) {
    const { q, r } = loadQueue.shift()!
    const k = key(q, r)
    queued.delete(k)

    // Skip if already cached or not occupied
    if (svgCache.has(k) || !isOccupied(q, r)) {
      continue
    }

    inFlight++
    // Fetch as text to extract embedded metadata, then load as image
    fetch(`${TILE_CDN}/${q}/${r}.svg`)
      .then(res => {
        if (!res.ok) throw new Error('not found')
        return res.text()
      })
      .then(svgText => {
        // Extract metadata from SVG
        const tile = parseSvgMetadata(svgText, q, r)
        if (tile) metadataCache.set(k, tile)

        // Load as image from blob
        const blob = new Blob([svgText], { type: 'image/svg+xml' })
        const url = URL.createObjectURL(blob)
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          URL.revokeObjectURL(url)
          touchCache(k, img)
          evictCache()
          inFlight--
          scheduleRedraw()
          drainQueue()
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          inFlight--
          drainQueue()
        }
        img.src = url
      })
      .catch(() => {
        inFlight--
        drainQueue()
      })
  }
}

/**
 * Poll for a newly-minted tile's SVG, load it, update cache, and redraw.
 */
export async function awaitTilePlacement(q: number, r: number, timeoutMs = 60_000): Promise<boolean> {
  const k = key(q, r)
  markOccupied(q, r)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${TILE_CDN}/${q}/${r}.svg`)
      if (res.ok) {
        const svgText = await res.text()
        // Extract metadata from SVG
        const tile = parseSvgMetadata(svgText, q, r)
        if (tile) metadataCache.set(k, tile)

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
        touchCache(k, img)
        evictCache()
        scheduleRedraw()
        return true
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 2000))
  }
  return false
}

/**
 * Returns the cached SVG image for (q,r) if available.
 * If not cached and cell is occupied, queues a fetch.
 */
export function ensureSvgLoaded(q: number, r: number): HTMLImageElement | undefined {
  const k = key(q, r)
  const cached = svgCache.get(k)
  if (cached) {
    touchCache(k, cached)
    return cached
  }

  // Only fetch SVGs for occupied cells
  if (!isOccupied(q, r)) return undefined

  // Queue for fetching (deduplicate)
  if (!queued.has(k)) {
    queued.add(k)
    loadQueue.push({ q, r })
    drainQueue()
  }

  return undefined
}
