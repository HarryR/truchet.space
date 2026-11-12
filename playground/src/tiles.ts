/**
 * Tile image cache: SVG text (from the solver pool) → decoded image →
 * rasterised bitmaps, pre-clipped to the hexagon so the renderer can blit
 * them with a single drawImage and no per-tile clip.
 *
 * SVGs are a pure function of (ka, kb, kc, polarity, idx), so entries are
 * keyed by that and shared between all cells (and the placement preview).
 */

import { RASTER_BUDGET_MS, RASTER_CACHE_BYTES, TILE_CACHE_MAX } from './config'
import { solveKey, type SolveParams } from './solver/protocol'
import type { SolverPool } from './solver/pool'

/**
 * Raster region in SVG units. The solver draws the hexagon with vertices at
 * x ∈ [0, 80], y ∈ [0, 40√3]; we keep a 1-unit margin.
 */
export const HEX_W = 80
export const HEX_H = 40 * Math.sqrt(3)
const MARGIN = 1
export const RASTER_W = HEX_W + 2 * MARGIN
export const RASTER_H = HEX_H + 2 * MARGIN
/**
 * Bleed, in SVG units: each tile is drawn scaled up about its centre by this
 * much at the corners, and clipped to the matching larger hexagon, so
 * neighbours overlap and no seams show. Both tiles on a shared edge stretch
 * along it identically, so the pattern still lines up across the overlap.
 */
const BLEED = 0.6

type State = 'solving' | 'decoding' | 'ready' | 'failed'

interface Raster {
  bucket: number
  canvas: HTMLCanvasElement
  bytes: number
}

interface Entry {
  key: string
  state: State
  svg?: string
  img?: HTMLImageElement
  /** viewBox of the SVG, in SVG units. */
  vb?: [number, number, number, number]
  raster?: Raster
}

export interface Drawable {
  canvas: HTMLCanvasElement
  /** True if the bitmap is at the requested resolution. */
  exact: boolean
}

export class TileCache {
  private entries = new Map<string, Entry>()
  private rasterBytes = 0
  private frameDeadline = 0
  /** Set when a frame ran out of raster budget and needs a follow-up frame. */
  needsMore = false
  private listeners = new Set<(key: string) => void>()

  private pool: SolverPool

  constructor(pool: SolverPool) {
    this.pool = pool
  }

  /** Handle a solver result (wire this to the pool's onResult). */
  handleResult = (key: string, svg: string | null) => {
    const e = this.entries.get(key)
    if (!e || e.state !== 'solving') return
    if (!svg) {
      e.state = 'failed'
      this.emit(key)
      return
    }
    e.svg = svg
    e.state = 'decoding'
    this.decode(e)
  }

  /** Subscribe to "entry became ready/failed" events. */
  onChange(fn: (key: string) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  beginFrame() {
    this.frameDeadline = performance.now() + RASTER_BUDGET_MS
    this.needsMore = false
  }

  /**
   * Get something drawable for a tile at a raster size `bucket` (px across
   * RASTER_W). Starts solving / rasterising as needed. Returns null while
   * nothing is available yet.
   */
  get(params: SolveParams, bucket: number, priority: number): Drawable | null {
    const key = solveKey(params)
    let e = this.entries.get(key)
    if (!e) {
      e = { key, state: 'solving' }
      this.entries.set(key, e)
      this.evictEntries()
    } else {
      // LRU touch
      this.entries.delete(key)
      this.entries.set(key, e)
    }

    if (e.state === 'solving') {
      this.pool.request(params, priority)
      return null
    }
    if (e.state !== 'ready') return null

    if (!e.raster || e.raster.bucket !== bucket) {
      if (performance.now() < this.frameDeadline) {
        this.rasterise(e, bucket)
      } else {
        this.needsMore = true
      }
    }
    return e.raster ? { canvas: e.raster.canvas, exact: e.raster.bucket === bucket } : null
  }

  state(params: SolveParams): State | undefined {
    return this.entries.get(solveKey(params))?.state
  }

  svg(params: SolveParams): string | undefined {
    return this.entries.get(solveKey(params))?.svg
  }

  // ── Internals ──

  private emit(key: string) {
    for (const fn of this.listeners) fn(key)
  }

  private decode(e: Entry) {
    const m = e.svg!.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/)
    if (!m) { e.state = 'failed'; this.emit(e.key); return }
    const vb = [+m[1], +m[2], +m[3], +m[4]] as [number, number, number, number]
    // Make the intrinsic size match the viewBox exactly so drawing at the
    // viewBox rectangle is an exact mapping (the solver rounds width/height).
    // Drop the solver's backdrop rectangle: only the hexagon itself is wanted,
    // otherwise the backdrop shows as a light rim in the bleed.
    const svg = e.svg!.replace(/<rect [^>]*\/>/, '').replace(/<svg([^>]*?) width="[^"]*" height="[^"]*"/, `<svg$1 width="${vb[2]}" height="${vb[3]}"`)
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const img = new Image()
    img.src = url
    img.decode().then(() => {
      e.img = img
      e.vb = vb
      e.state = 'ready'
    }, () => {
      e.state = 'failed'
    }).finally(() => {
      URL.revokeObjectURL(url)
      this.emit(e.key)
    })
  }

  private rasterise(e: Entry, bucket: number) {
    const w = bucket
    const h = Math.ceil(bucket * RASTER_H / RASTER_W)
    const canvas = e.raster?.canvas ?? document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const s = w / RASTER_W
    ctx.setTransform(s, 0, 0, s, MARGIN * s, MARGIN * s)
    ctx.clearRect(-MARGIN, -MARGIN, RASTER_W, RASTER_H)
    // Hexagon clip around the tile centre (40, 20√3), grown by the bleed.
    const cx = HEX_W / 2, cy = HEX_H / 2, R = HEX_W / 2 + BLEED
    ctx.beginPath()
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i
      ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a))
    }
    ctx.closePath()
    ctx.clip()
    const [x, y, vw, vh] = e.vb!
    const k = R / (HEX_W / 2)
    ctx.drawImage(e.img!, cx + (x - cx) * k, cy + (y - cy) * k, vw * k, vh * k)

    const bytes = w * h * 4
    if (e.raster) this.rasterBytes -= e.raster.bytes
    e.raster = { bucket, canvas, bytes }
    this.rasterBytes += bytes
    this.evictRasters(e)
  }

  /** Drop least-recently-used rasters (keeping the decoded image) over budget. */
  private evictRasters(keep: Entry) {
    if (this.rasterBytes <= RASTER_CACHE_BYTES) return
    for (const e of this.entries.values()) {
      if (this.rasterBytes <= RASTER_CACHE_BYTES * 0.8) break
      if (e === keep || !e.raster) continue
      this.rasterBytes -= e.raster.bytes
      e.raster.canvas.width = e.raster.canvas.height = 0
      e.raster = undefined
    }
  }

  /** Drop least-recently-used entries entirely over the count limit. */
  private evictEntries() {
    while (this.entries.size > TILE_CACHE_MAX) {
      const [key, e] = this.entries.entries().next().value!
      if (e.raster) {
        this.rasterBytes -= e.raster.bytes
        e.raster.canvas.width = e.raster.canvas.height = 0
      }
      // An evicted 'solving' entry may still get a result; handleResult ignores it.
      this.entries.delete(key)
    }
  }
}
