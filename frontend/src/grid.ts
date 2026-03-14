/**
 * Grid state — pure data structures for occupancy, SVG cache, and metadata.
 * No network calls, no notification, no scheduling.
 */

import { SVG_CACHE_MAX } from './config'
import { MASK, neighbors } from './hex'

export interface TileData {
  q: number
  r: number
  ka: number
  kb: number
  kc: number
  polarity: boolean
  catalanIndex: bigint
  minter?: string
}

// ── Occupancy cache ──

/** Repacked occupancy words: wordIndex (0-1023) → 256-bit occupancy. */
const occCache = new Map<number, bigint>()

/**
 * Frontier: word indices adjacent to occupied words.
 * Maps word index → timestamp of last fetch (0 = never fetched).
 */
const frontierWords = new Map<number, number>()

/** Word indices that contain occupied cells. Tracks last-fetch time for re-polling. */
const occupiedWords = new Map<number, number>()

/** Block index for a cell: 16×16 blocks, 1024 total. */
export function blockIndex(q: number, r: number): number {
  return (((q & MASK) >> 4) << 5) | ((r & MASK) >> 4)
}

/** Bit position within a block's 256-bit word. */
function blockBit(q: number, r: number): number {
  const lq = q & 15
  const lr = r & 15
  const sub = ((lq >> 3) << 1) | (lr >> 3)
  const cell = ((lq & 7) << 3) | (lr & 7)
  return (sub << 6) | cell
}

/** Check if a cell is occupied (placed tile or marked dead). */
export function isOccupied(q: number, r: number): boolean {
  const wi = blockIndex(q, r)
  const bit = blockBit(q, r)
  const word = occCache.get(wi)
  if (word === undefined) return false
  return (word & (1n << BigInt(bit))) !== 0n
}

/** Alias — true if occupied on-chain. */
export function isPlaced(q: number, r: number): boolean {
  return isOccupied(q, r)
}

/** Mark a cell as dead (unplaceable) in the local occupancy cache. */
export function markDead(q: number, r: number) {
  const wi = blockIndex(q, r)
  const bit = blockBit(q, r)
  const word = occCache.get(wi) ?? 0n
  occCache.set(wi, word | (1n << BigInt(bit)))
}

/** Set a cell as occupied in the local cache (e.g. after minting). */
export function markOccupied(q: number, r: number) {
  const wi = blockIndex(q, r)
  const bit = blockBit(q, r)
  const word = occCache.get(wi) ?? 0n
  occCache.set(wi, word | (1n << BigInt(bit)))
  occupiedWords.set(wi, Date.now())
}

// ── Occupancy bulk update ──

/** Apply fetched occupancy words into cache. Called by store after RPC fetch. */
export function applyOccupancyWords(results: Map<number, bigint>) {
  for (const [wi, word] of results) {
    occCache.set(wi, word)
  }
}

// ── Frontier tracking ──

/**
 * After fetching words, scan occupied cells for neighbors in unfetched words.
 * Those unfetched neighbor words become the new frontier.
 */
export function expandFrontier(wordIndices: Iterable<number>) {
  const now = Date.now()
  for (const wi of wordIndices) {
    const word = occCache.get(wi) ?? 0n
    if (word !== 0n) {
      occupiedWords.set(wi, now)
      const bq = wi >> 5
      const br = wi & 31
      for (let bit = 0; bit < 256; bit++) {
        if ((word & (1n << BigInt(bit))) === 0n) continue
        const sub = bit >> 6
        const cell = bit & 63
        const lq = ((sub >> 1) << 3) | (cell >> 3)
        const lr = ((sub & 1) << 3) | (cell & 7)
        const q = ((bq << 4) | lq) & MASK
        const r = ((br << 4) | lr) & MASK
        for (const { q: nq, r: nr } of neighbors(q, r)) {
          const nwi = blockIndex(nq, nr)
          if (!occCache.has(nwi) && !frontierWords.has(nwi)) {
            frontierWords.set(nwi, 0)
          }
        }
      }
    }
    frontierWords.set(wi, now)
  }
}

// ── Block queries (for store to decide what to fetch) ──

/** Return word indices from activeBlocks that are stale (frontier or occupied). */
export function getStaleWordIndices(activeBlocks: Set<number>, now: number, staleness: number): number[] {
  const result: number[] = []
  for (const wi of activeBlocks) {
    const ft = frontierWords.get(wi)
    const ot = occupiedWords.get(wi)
    if (ft !== undefined && now - ft >= staleness) {
      result.push(wi)
    } else if (ot !== undefined && now - ot >= staleness) {
      if (!result.includes(wi)) result.push(wi)
    }
  }
  return result
}

/** Return word indices visible in activeBlocks that have never been fetched. */
export function getUnfetchedWordIndices(activeBlocks: Set<number>): number[] {
  const result: number[] = []
  for (const wi of activeBlocks) {
    if (!occCache.has(wi)) {
      result.push(wi)
    }
  }
  return result
}

/** Return word indices that are frontier, visible, and stale. */
export function getStaleFrontierIndices(activeBlocks: Set<number>, now: number, staleness: number): number[] {
  const result: number[] = []
  for (const [wi, lastFetched] of frontierWords) {
    if (activeBlocks.has(wi) && now - lastFetched >= staleness) {
      result.push(wi)
    }
  }
  for (const [wi, lastFetched] of occupiedWords) {
    if (activeBlocks.has(wi) && now - lastFetched >= staleness) {
      if (!result.includes(wi)) result.push(wi)
    }
  }
  return result
}

/** Get all occupied cells in a given word/block index. */
export function getOccupiedCellsInBlock(wordIndex: number): { q: number; r: number }[] {
  const word = occCache.get(wordIndex) ?? 0n
  if (word === 0n) return []
  const cells: { q: number; r: number }[] = []
  const bq = wordIndex >> 5
  const br = wordIndex & 31
  for (let bit = 0; bit < 256; bit++) {
    if ((word & (1n << BigInt(bit))) === 0n) continue
    const sub = bit >> 6
    const cell = bit & 63
    const lq = ((sub >> 1) << 3) | (cell >> 3)
    const lr = ((sub & 1) << 3) | (cell & 7)
    const q = ((bq << 4) | lq) & MASK
    const r = ((br << 4) | lr) & MASK
    cells.push({ q, r })
  }
  return cells
}

/** Get frontier cells (empty, adjacent to occupied) in a block. */
export function getFrontierCellsInBlock(wordIndex: number): { q: number; r: number }[] {
  const bq = wordIndex >> 5
  const br = wordIndex & 31
  const cells: { q: number; r: number }[] = []
  const seen = new Set<string>()
  for (let lq = 0; lq < 16; lq++) {
    for (let lr = 0; lr < 16; lr++) {
      const q = ((bq << 4) | lq) & MASK
      const r = ((br << 4) | lr) & MASK
      if (isOccupied(q, r)) continue
      let adjacent = false
      for (const { q: nq, r: nr } of neighbors(q, r)) {
        if (isOccupied(nq, nr)) { adjacent = true; break }
      }
      if (!adjacent) continue
      const k = `${q},${r}`
      if (seen.has(k)) continue
      seen.add(k)
      cells.push({ q, r })
    }
  }
  return cells
}

/** Check if the occupancy cache has any data (for bootstrap detection). */
export function hasOccupancyData(): boolean {
  return occCache.size > 0
}

/** Get raw occupancy word for a block index. Used for change detection. */
export function getOccupancyWord(wi: number): bigint {
  return occCache.get(wi) ?? 0n
}

// ── Metadata cache ──

const metadataCache = new Map<string, TileData>()

function key(q: number, r: number): string {
  return `${q},${r}`
}

/** Parse metadata JSON from SVG text. Format: <metadata>{...}</metadata> */
export function parseSvgMetadata(svgText: string, q: number, r: number): TileData | undefined {
  const start = svgText.indexOf('<metadata>')
  const end = svgText.indexOf('</metadata>')
  if (start < 0 || end < 0) return undefined
  try {
    const json = JSON.parse(svgText.slice(start + 10, end))
    const eps = json.config?.eps as number[] | undefined
    if (!eps || eps.length !== 3) return undefined
    const [ka, kb, kc] = eps
    const catalanIndex = BigInt(json.tiles?.[0]?.[0] ?? '0')
    const polarity = json.tiles?.[0]?.[1] === 1
    const minter = json.minter as string | undefined
    return { q, r, ka, kb, kc, polarity, catalanIndex, minter }
  } catch {
    return undefined
  }
}

export function getTile(q: number, r: number): TileData | undefined {
  return metadataCache.get(key(q, r))
}

/** Store parsed metadata. Called by store after SVG/CDN fetch. */
export function putMetadata(q: number, r: number, tile: TileData) {
  metadataCache.set(key(q, r), tile)
}

// ── LRU SVG cache ──

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

/** Get cached SVG image (pure LRU read). */
export function getSvg(q: number, r: number): HTMLImageElement | undefined {
  const k = key(q, r)
  const cached = svgCache.get(k)
  if (cached) {
    touchCache(k, cached)
    return cached
  }
  return undefined
}

/** Insert SVG image into cache + LRU evict. Called by store after fetch. */
export function putSvg(q: number, r: number, img: HTMLImageElement) {
  const k = key(q, r)
  touchCache(k, img)
  evictCache()
}

/** Check if SVG is already cached. */
export function hasSvg(q: number, r: number): boolean {
  return svgCache.has(key(q, r))
}
