/**
 * Canvas renderer. Draws on requestAnimationFrame, only when something
 * changed. Tiles are blitted from pre-clipped rasters (see tiles.ts); empty
 * cells and the frontier are batched into a few Path2D fills.
 */

import { hexToPixel } from '../hex'
import { RASTER_H, RASTER_W, HEX_W, type TileCache } from '../tiles'
import { solveKey } from '../solver/protocol'
import { cellKey, type World } from '../world'
import { layout, type Camera, type Cell } from './camera'
import type { SolverPool } from '../solver/pool'

export interface Overlay {
  hovered: Cell | null
}

const COLORS = {
  bg: '#0a0a0a',
  loading: '#1a1f24',
  failed: '#3a1d1d',
  solving: '#ffffff',
  frontier: 'rgba(70, 160, 110, 0.22)',
  frontierFill: 'rgba(70, 160, 110, 0.04)',
  hover: 'rgba(120, 220, 160, 0.22)',
}

const CORNERS: [number, number][] = [0, 1, 2, 3, 4, 5].map(i => {
  const a = (Math.PI / 3) * i
  return [Math.cos(a), Math.sin(a)]
})

function addHex(p: Path2D, cx: number, cy: number, s: number) {
  p.moveTo(cx + s * CORNERS[0][0], cy + s * CORNERS[0][1])
  for (let i = 1; i < 6; i++) p.lineTo(cx + s * CORNERS[i][0], cy + s * CORNERS[i][1])
  p.closePath()
}

export class Renderer {
  private ctx: CanvasRenderingContext2D
  private queued = false
  private dpr = 1
  overlay: Overlay = { hovered: null }
  /** Called after each frame (for HUD updates). */
  afterDraw: (() => void) | null = null

  private canvas: HTMLCanvasElement
  private camera: Camera
  private world: World
  private tiles: TileCache
  private pool: SolverPool

  constructor(canvas: HTMLCanvasElement, camera: Camera, world: World, tiles: TileCache, pool: SolverPool) {
    this.canvas = canvas
    this.camera = camera
    this.world = world
    this.tiles = tiles
    this.pool = pool
    this.ctx = canvas.getContext('2d', { alpha: false })!
    world.subscribe(() => this.request())
    tiles.onChange(() => this.request())
    pool.onStart = () => this.request()
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight
    // Cap DPR: beyond 2 costs memory and fill-rate on phones for little gain.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(w * this.dpr)
    this.canvas.height = Math.round(h * this.dpr)
    this.camera.setViewport(w, h)
    this.request()
  }

  request() {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      this.draw()
    })
  }

  /** Raster bucket (px across RASTER_W) for the current zoom: next power of two. */
  private bucket(): number {
    const px = (RASTER_W / HEX_W) * layout.width * this.camera.zoom * this.dpr
    return Math.min(1024, Math.max(16, 2 ** Math.ceil(Math.log2(px))))
  }

  private draw() {
    const { ctx, camera, world, tiles } = this
    const dpr = this.dpr
    const z = camera.zoom
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = COLORS.bg
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(dpr * z, 0, 0, dpr * z,
      dpr * (camera.width / 2 - camera.x * z), dpr * (camera.height / 2 - camera.y * z))
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'medium'

    this.pool.beginFrame()
    tiles.beginFrame()
    const bucket = this.bucket()
    const { q0, q1, r0, r1 } = camera.visibleRange()
    const midQ = (q0 + q1) / 2, midR = (r0 + r1) / 2
    const s = layout.size
    const loading = new Path2D(), failed = new Path2D()
    const frontier = new Path2D()
    const solving = new Path2D()
    // Dot radius: ~3 CSS px, but never more than a fifth of the hex.
    const dotR = Math.min(3 / z, s * 0.2)

    for (let uq = q0; uq <= q1; uq++) {
      for (let ur = r0; ur <= r1; ur++) {
        const [cx, cy] = hexToPixel(layout, uq, ur)
        const t = world.get(uq, ur)
        if (t) {
          const priority = -((uq - midQ) ** 2 + (ur - midR) ** 2)
          const params = { ka: t.ka, kb: t.kb, kc: t.kc, polarity: t.polarity, idx: t.idx }
          const d = tiles.get(params, bucket, priority)
          if (d) {
            ctx.drawImage(d.canvas, cx - RASTER_W / 2, cy - RASTER_H / 2, RASTER_W, RASTER_H)
          } else {
            addHex(tiles.state(params) === 'failed' ? failed : loading, cx, cy, s - 1)
            if (this.pool.isSolving(solveKey(params))) {
              solving.moveTo(cx + dotR, cy)
              solving.arc(cx, cy, dotR, 0, Math.PI * 2)
            }
          }
          continue
        }
        const k = cellKey(uq, ur)
        if (world.frontier().has(k)) {
          addHex(frontier, cx, cy, s - 1.5)
        }
      }
    }

    ctx.fillStyle = COLORS.loading
    ctx.fill(loading)
    ctx.fillStyle = COLORS.failed
    ctx.fill(failed)
    ctx.fillStyle = COLORS.solving
    ctx.fill(solving)
    ctx.fillStyle = COLORS.frontierFill
    ctx.fill(frontier)
    ctx.lineWidth = Math.max(1, 1.5 / z)
    ctx.strokeStyle = COLORS.frontier
    ctx.stroke(frontier)

    // Hover: cells a tap acts on (fill an empty one, or regenerate a tile).
    const hov = this.overlay.hovered
    if (hov && (world.get(hov.q, hov.r) || world.canPlace(hov.q, hov.r))) {
      const [cx, cy] = hexToPixel(layout, hov.uq, hov.ur)
      const p = new Path2D()
      addHex(p, cx, cy, s - 1.5)
      ctx.fillStyle = COLORS.hover
      ctx.fill(p)
    }

    if (tiles.needsMore) this.request()
    this.afterDraw?.()
  }
}
