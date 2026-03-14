import './style.css'
import { createLayout, hexToPixel, hexPath, hexPathInset, pixelToHex, wrap } from './hex'
import { GRID_SIZE, VIEWPORT_DEBOUNCE_MS, MAX_VISIBLE_CELLS } from './config'
import { isPlaced, blockIndex } from './grid'
import { initMenu } from './menu'
import { onChange as onWalletChange } from './wallet'
import { initTilePanel, showTilePanel, getSelectedTile, refreshTilePanel } from './tilePanel'
import * as store from './store'

const canvas = document.getElementById('grid') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

// ── Camera (pan + zoom) ──

const camera = { x: 0, y: 0, zoom: 1 }
const HEX_SIZE = 40
const layout = createLayout(HEX_SIZE)

/** Screen pixel → world pixel. */
function screenToWorld(sx: number, sy: number): [number, number] {
  return [
    (sx - canvas.clientWidth / 2) / camera.zoom + camera.x,
    (sy - canvas.clientHeight / 2) / camera.zoom + camera.y,
  ]
}

/** Minimum zoom so the visible cell count stays ≤ 2500. */
function minZoom(): number {
  const w = canvas.clientWidth || 1
  const h = canvas.clientHeight || 1
  return Math.sqrt((w * h) / (layout.colStep * layout.rowStep * MAX_VISIBLE_CELLS))
}

// ── Resize ──

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio
  canvas.height = window.innerHeight * devicePixelRatio
  canvas.style.width = window.innerWidth + 'px'
  canvas.style.height = window.innerHeight + 'px'
  camera.zoom = Math.max(camera.zoom, minZoom())
  draw()
  scheduleViewportRefresh()
}

// ── Draw ──

function draw() {
  const w = canvas.clientWidth
  const h = canvas.clientHeight

  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const pad = layout.width
  const [wx0, wy0] = screenToWorld(-pad, -pad)
  const [wx1, wy1] = screenToWorld(w + pad, h + pad)

  const qMin = Math.floor(wx0 / layout.colStep) - 1
  const qMax = Math.ceil(wx1 / layout.colStep) + 1
  const rMin = Math.floor(wy0 / layout.rowStep) - 1
  const rMax = Math.ceil(wy1 / layout.rowStep) + 1

  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(camera.zoom, camera.zoom)
  ctx.translate(-camera.x, -camera.y)

  const inset = 2 / camera.zoom
  for (let q = qMin; q <= qMax; q++) {
    const wq = wrap(q)
    for (let r = rMin; r <= rMax; r++) {
      const wr = wrap(r)
      const [cx, cy] = hexToPixel(layout, q, r)
      const img = store.ensureSvgLoaded(wq, wr)

      if (img) {
        ctx.save()
        hexPathInset(ctx, layout, cx, cy, -0.5)
        ctx.clip()
        const svgPad = 4
        const over = 1
        const drawW = layout.width + svgPad * 2 + over * 2
        const drawH = layout.height + svgPad * 2 + over * 2
        ctx.drawImage(img, cx - layout.size - svgPad - over, cy - layout.height / 2 - svgPad - over, drawW, drawH)
        ctx.restore()
      } else {
        hexPathInset(ctx, layout, cx, cy, inset)
        ctx.strokeStyle = '#222'
        ctx.lineWidth = 0.5 / camera.zoom
        ctx.stroke()
      }
    }
  }

  // Highlight selected cell
  const selectedTile = getSelectedTile()
  if (selectedTile) {
    const sq = selectedTile.q, sr = selectedTile.r
    const ctrQ = Math.round(camera.x / layout.colStep)
    const ctrR = Math.round(camera.y / layout.rowStep)
    const half = GRID_SIZE >> 1
    let dq = wrap(ctrQ - sq); if (dq >= half) dq -= GRID_SIZE
    let dr = wrap(ctrR - sr); if (dr >= half) dr -= GRID_SIZE
    const bestQ = ctrQ - dq
    const bestR = ctrR - dr
    const [scx, scy] = hexToPixel(layout, bestQ, bestR)
    hexPath(ctx, layout, scx, scy)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2 / camera.zoom
    ctx.stroke()
  }

  // Highlight hovered cell
  if (hovered) {
    const [cx, cy] = hexToPixel(layout, hovered.wq, hovered.wr)
    hexPath(ctx, layout, cx, cy)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)'
    ctx.fill()
    ctx.strokeStyle = '#666'
    ctx.lineWidth = 1 / camera.zoom
    ctx.stroke()
  }

  ctx.restore()

  // HUD
  ctx.fillStyle = '#888'
  ctx.font = '13px system-ui'
  if (hovered) {
    const placed = isPlaced(hovered.q, hovered.r)
    let text = `(${hovered.q}, ${hovered.r})`
    if (placed) text += '  placed'
    ctx.fillText(text, 12, h - 12)
  }
}

// ── Viewport → active blocks ──

function computeVisibleBlockIndices(): Set<number> {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  const pad = layout.width
  const [wx0, wy0] = screenToWorld(-pad, -pad)
  const [wx1, wy1] = screenToWorld(w + pad, h + pad)
  const qMin = Math.floor(wx0 / layout.colStep) - 1
  const qMax = Math.ceil(wx1 / layout.colStep) + 1
  const rMin = Math.floor(wy0 / layout.rowStep) - 1
  const rMax = Math.ceil(wy1 / layout.rowStep) + 1

  const blocks = new Set<number>()
  for (let q = qMin; q <= qMax; q++) {
    for (let r = rMin; r <= rMax; r++) {
      blocks.add(blockIndex(wrap(q), wrap(r)))
    }
  }
  return blocks
}

let viewportDebounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleViewportRefresh() {
  if (viewportDebounceTimer !== null) clearTimeout(viewportDebounceTimer)
  viewportDebounceTimer = setTimeout(() => {
    viewportDebounceTimer = null
    store.setActiveBlocks(computeVisibleBlockIndices())
  }, VIEWPORT_DEBOUNCE_MS)
}

// ── Interaction: pan, zoom, hover ──

let dragging = false
let didDrag = false
let lastMouse = { x: 0, y: 0 }
let downMouse = { x: 0, y: 0 }
let hovered: { q: number; r: number; wq: number; wr: number } | null = null

canvas.addEventListener('pointerdown', (e) => {
  dragging = true
  didDrag = false
  lastMouse = { x: e.clientX, y: e.clientY }
  downMouse = { x: e.clientX, y: e.clientY }
  canvas.setPointerCapture(e.pointerId)
})

canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    const dx = e.clientX - lastMouse.x
    const dy = e.clientY - lastMouse.y
    if (Math.abs(e.clientX - downMouse.x) > 4 || Math.abs(e.clientY - downMouse.y) > 4) {
      didDrag = true
    }
    camera.x -= dx / camera.zoom
    camera.y -= dy / camera.zoom
    lastMouse = { x: e.clientX, y: e.clientY }
    draw()
    scheduleViewportRefresh()
  } else {
    const [wx, wy] = screenToWorld(e.clientX, e.clientY)
    const hex = pixelToHex(layout, wx, wy)
    const wq = Math.round(wx / layout.colStep)
    const wr = Math.round((wy - (wq & 1 ? layout.rowStep * 0.5 : 0)) / layout.rowStep)
    if (!hovered || hovered.wq !== wq || hovered.wr !== wr) {
      hovered = { ...hex, wq, wr }
      draw()
    }
  }
})

canvas.addEventListener('pointerup', () => {
  dragging = false
  if (!didDrag && hovered) {
    showTilePanel(hovered.q, hovered.r)
    history.replaceState(null, '', `#tile=${hovered.q},${hovered.r}`)
  }
})

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const factor = e.deltaY > 0 ? 0.9 : 1.1
  const newZoom = Math.min(Math.max(camera.zoom * factor, minZoom()), 10)

  const [wx, wy] = screenToWorld(e.clientX, e.clientY)
  camera.zoom = newZoom
  const [wx2, wy2] = screenToWorld(e.clientX, e.clientY)
  camera.x -= wx2 - wx
  camera.y -= wy2 - wy

  draw()
  scheduleViewportRefresh()
}, { passive: false })

// ── Hash-based tile focus: #tile=q,r ──

function parseTileHash(): [number, number] | null {
  const m = location.hash.match(/^#tile=(\d+),(\d+)$/)
  if (!m) return null
  const q = parseInt(m[1], 10)
  const r = parseInt(m[2], 10)
  if (q < 0 || q >= GRID_SIZE || r < 0 || r >= GRID_SIZE) return null
  return [q, r]
}

function focusTile(q: number, r: number) {
  const [px, py] = hexToPixel(layout, q, r)
  camera.x = px
  camera.y = py
  const vw = canvas.clientWidth || 1
  const vh = canvas.clientHeight || 1
  camera.zoom = Math.min(vw / (4 * layout.width), vh / (4 * layout.height))
}

// ── Init ──

camera.x = 0
camera.y = 0

initTilePanel(draw)
initMenu()

// Store changes → redraw
store.subscribe(() => { draw() })

// Wallet changes → invalidate prices
onWalletChange(() => {
  store.invalidatePrices()
  refreshTilePanel()
})

window.addEventListener('resize', resize)
resize()

// Focus on hash tile if present
const hashTile = parseTileHash()
if (hashTile) {
  focusTile(hashTile[0], hashTile[1])
  showTilePanel(hashTile[0], hashTile[1])
}

window.addEventListener('hashchange', () => {
  const tile = parseTileHash()
  if (tile) {
    focusTile(tile[0], tile[1])
    showTilePanel(tile[0], tile[1])
  }
})
