/**
 * Camera over the torus: centre (x, y) in world pixels and a zoom factor.
 * World pixels are unbounded; the camera is re-wrapped into one torus period
 * so float precision never degrades.
 */

import { GRID_SIZE, HEX_SIZE, MAX_VISIBLE_CELLS, MAX_ZOOM } from '../config'
import { createLayout, hexToPixel, wrap, type HexLayout } from '../hex'

export const layout: HexLayout = createLayout(HEX_SIZE)

/** One torus period in world pixels. */
export const PERIOD_X = GRID_SIZE * layout.colStep
export const PERIOD_Y = GRID_SIZE * layout.rowStep

/** An unwrapped cell (for drawing) with its wrapped torus coordinates. */
export interface Cell {
  /** Unwrapped column/row — position on screen. */
  uq: number
  ur: number
  /** Torus coordinates in [0, 511]. */
  q: number
  r: number
}

export class Camera {
  x = 0
  y = 0
  zoom = 1
  /** Viewport size in CSS pixels. */
  width = 1
  height = 1

  setViewport(w: number, h: number) {
    this.width = Math.max(1, w)
    this.height = Math.max(1, h)
    this.zoom = this.clampZoom(this.zoom)
  }

  minZoom(): number {
    return Math.sqrt((this.width * this.height) / (layout.colStep * layout.rowStep * MAX_VISIBLE_CELLS))
  }

  clampZoom(z: number): number {
    return Math.min(Math.max(z, this.minZoom()), MAX_ZOOM)
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [
      (sx - this.width / 2) / this.zoom + this.x,
      (sy - this.height / 2) / this.zoom + this.y,
    ]
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [
      (wx - this.x) * this.zoom + this.width / 2,
      (wy - this.y) * this.zoom + this.height / 2,
    ]
  }

  panBy(dsx: number, dsy: number) {
    this.x -= dsx / this.zoom
    this.y -= dsy / this.zoom
    this.rewrap()
  }

  /** Zoom by `factor`, keeping the world point under screen (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number) {
    const [wx, wy] = this.screenToWorld(sx, sy)
    this.zoom = this.clampZoom(this.zoom * factor)
    const [wx2, wy2] = this.screenToWorld(sx, sy)
    this.x -= wx2 - wx
    this.y -= wy2 - wy
    this.rewrap()
  }

  /** Centre on a torus cell, choosing the copy nearest the current view. */
  centerOn(q: number, r: number, zoom?: number) {
    const c = this.nearestCopy(q, r)
    ;[this.x, this.y] = hexToPixel(layout, c.uq, c.ur)
    if (zoom !== undefined) this.zoom = this.clampZoom(zoom)
    this.rewrap()
  }

  /** The cell under a screen point (exact hexagon hit test). */
  pick(sx: number, sy: number): Cell {
    const [wx, wy] = this.screenToWorld(sx, sy)
    const q0 = Math.round(wx / layout.colStep)
    let best: Cell = { uq: 0, ur: 0, q: 0, r: 0 }
    let bestD = Infinity
    for (let uq = q0 - 1; uq <= q0 + 1; uq++) {
      const off = uq & 1 ? layout.rowStep / 2 : 0
      const ur = Math.round((wy - off) / layout.rowStep)
      const [cx, cy] = hexToPixel(layout, uq, ur)
      const d = (cx - wx) ** 2 + (cy - wy) ** 2
      if (d < bestD) { bestD = d; best = { uq, ur, q: wrap(uq), r: wrap(ur) } }
    }
    return best
  }

  /** Unwrapped coordinates of torus cell (q, r) nearest the camera centre. */
  nearestCopy(q: number, r: number): Cell {
    const cq = Math.round(this.x / layout.colStep)
    const cr = Math.round(this.y / layout.rowStep)
    const half = GRID_SIZE >> 1
    let dq = wrap(q - cq); if (dq >= half) dq -= GRID_SIZE
    let dr = wrap(r - cr); if (dr >= half) dr -= GRID_SIZE
    return { uq: cq + dq, ur: cr + dr, q, r }
  }

  /** The torus cell at the centre of the screen. */
  centerCell(): Cell {
    return this.pick(this.width / 2, this.height / 2)
  }

  /** Visible unwrapped cell range (inclusive), padded by one cell. */
  visibleRange(): { q0: number; q1: number; r0: number; r1: number } {
    const [wx0, wy0] = this.screenToWorld(0, 0)
    const [wx1, wy1] = this.screenToWorld(this.width, this.height)
    return {
      q0: Math.floor(wx0 / layout.colStep) - 1,
      q1: Math.ceil(wx1 / layout.colStep) + 1,
      r0: Math.floor(wy0 / layout.rowStep) - 1,
      r1: Math.ceil(wy1 / layout.rowStep) + 1,
    }
  }

  private rewrap() {
    // Shift by whole periods only (PERIOD_X spans an even number of columns,
    // so column parity — and therefore the layout — is preserved).
    if (this.x < 0 || this.x >= PERIOD_X) this.x -= Math.floor(this.x / PERIOD_X) * PERIOD_X
    if (this.y < 0 || this.y >= PERIOD_Y) this.y -= Math.floor(this.y / PERIOD_Y) * PERIOD_Y
  }
}
