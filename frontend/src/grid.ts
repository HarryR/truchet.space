/**
 * Grid state — tile index from /grid endpoint, LRU SVG cache, lazy loading.
 */

import { TILE_API } from './config'

export interface TileData {
  q: number
  r: number
  ka: number
  kb: number
  kc: number
  catalanIndex: number
}

// ── Tile index (populated by loadGrid) ──

const tileIndex = new Map<string, TileData>()
let allTileCoords: { q: number; r: number }[] = []

function key(q: number, r: number): string {
  return `${q},${r}`
}

export function getTile(q: number, r: number): TileData | undefined {
  return tileIndex.get(key(q, r))
}

/** Returns placed tiles whose coords fall within the given rect. */
export function tilesInRect(qMin: number, qMax: number, rMin: number, rMax: number): TileData[] {
  const result: TileData[] = []
  for (const coord of allTileCoords) {
    if (coord.q >= qMin && coord.q <= qMax && coord.r >= rMin && coord.r <= rMax) {
      result.push(tileIndex.get(key(coord.q, coord.r))!)
    }
  }
  return result
}

/** Fetch the full grid from /grid and populate the tile index. */
export async function loadGrid(): Promise<void> {
  const res = await fetch(`${TILE_API}/grid`)
  if (!res.ok) throw new Error(`/grid failed: ${res.status}`)
  const tiles: TileData[] = await res.json()
  tileIndex.clear()
  for (const t of tiles) {
    tileIndex.set(key(t.q, t.r), t)
  }
  allTileCoords = tiles.map(t => ({ q: t.q, r: t.r }))
}

// ── LRU SVG cache (max 500 images) ──

const SVG_CACHE_MAX = 500
const svgCache = new Map<string, HTMLImageElement>()

/** Touch a key — move it to the end (most-recently-used). */
function touchCache(k: string, img: HTMLImageElement) {
  svgCache.delete(k)
  svgCache.set(k, img)
}

/** Evict oldest entries until we're at capacity. */
function evictCache() {
  while (svgCache.size > SVG_CACHE_MAX) {
    const oldest = svgCache.keys().next().value!
    svgCache.delete(oldest)
    // evicted oldest entry
  }
}

// ── Lazy SVG loading with concurrency cap ──

const MAX_CONCURRENT = 20
let inFlight = 0
const loadQueue: { q: number; r: number }[] = []
const queued = new Set<string>()
const failed = new Set<string>()

/** Callback when new SVG images arrive. */
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

    // Skip if already cached, failed, or no tile data
    if (svgCache.has(k) || failed.has(k) || !tileIndex.has(k)) {
      queued.delete(k)
      continue
    }

    inFlight++
    queued.delete(k)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      touchCache(k, img)
      evictCache()
      inFlight--
      scheduleRedraw()
      drainQueue()
    }
    img.onerror = () => {
      console.warn(`[grid] failed ${k} → ${img.src}`)
      failed.add(k)
      inFlight--
      drainQueue()
    }
    img.src = `${TILE_API}/tile/${q}/${r}/svg`
  }
}

/**
 * Returns the cached SVG image for (q,r) if available.
 * If not cached, queues a lazy load and returns undefined.
 */
export function ensureSvgLoaded(q: number, r: number): HTMLImageElement | undefined {
  const k = key(q, r)
  const cached = svgCache.get(k)
  if (cached) {
    touchCache(k, cached)
    return cached
  }

  // Queue for loading if tile exists (deduplicate, skip failed)
  if (tileIndex.has(k) && !queued.has(k) && !failed.has(k)) {
    queued.add(k)
    loadQueue.push({ q, r })
    drainQueue()
  }

  return undefined
}
