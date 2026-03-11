import './style.css'
import { createLayout, hexToPixel, hexPath, hexPathInset, pixelToHex, GRID_SIZE } from './hex'
import { loadGrid, getTile, ensureSvgLoaded, setOnUpdate } from './grid'
import { initMenu } from './menu'
import { fetchTile, tokenIdOf, type OnChainTile } from './contracts'
import { isConnected } from './wallet'
import { NFT_ADDRESS, BLOCK_EXPLORER } from './config'

const MASK = GRID_SIZE - 1

const canvas = document.getElementById('grid') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

// ── Camera (pan + zoom) ──

// Camera x,y = world-space point at screen center.
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
  // cells ≈ (w / zoom / colStep) * (h / zoom / rowStep) ≤ 2500
  // zoom² ≥ w * h / (colStep * rowStep * 2500)
  return Math.sqrt((w * h) / (layout.colStep * layout.rowStep * 2500))
}

// ── Resize ──

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio
  canvas.height = window.innerHeight * devicePixelRatio
  canvas.style.width = window.innerWidth + 'px'
  canvas.style.height = window.innerHeight + 'px'
  // Clamp zoom after resize (screen got bigger → minZoom may have changed)
  camera.zoom = Math.max(camera.zoom, minZoom())
  draw()
}

// ── Draw ──

function draw() {
  const w = canvas.clientWidth
  const h = canvas.clientHeight

  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // World-space visible bounds (with padding)
  const pad = layout.width
  const [wx0, wy0] = screenToWorld(-pad, -pad)
  const [wx1, wy1] = screenToWorld(w + pad, h + pad)

  // Grid range to draw (no clamping — torus wraps, so we allow any range)
  const qMin = Math.floor(wx0 / layout.colStep) - 1
  const qMax = Math.ceil(wx1 / layout.colStep) + 1
  const rMin = Math.floor(wy0 / layout.rowStep) - 1
  const rMax = Math.ceil(wy1 / layout.rowStep) + 1

  // Transform: world → screen
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(camera.zoom, camera.zoom)
  ctx.translate(-camera.x, -camera.y)

  // ── Draw grid: seamless placed tiles, inset borders on empty cells ──
  // Coordinates wrap mod GRID_SIZE (torus). Raw q/r used for pixel position,
  // wrapped wq/wr used for tile data lookup.
  const inset = 2 / camera.zoom // border drawn inside so empty cells don't overlap neighbors
  for (let q = qMin; q <= qMax; q++) {
    const wq = ((q % GRID_SIZE) + GRID_SIZE) & MASK
    for (let r = rMin; r <= rMax; r++) {
      const wr = ((r % GRID_SIZE) + GRID_SIZE) & MASK
      const [cx, cy] = hexToPixel(layout, q, r)
      const tile = getTile(wq, wr)

      if (tile) {
        const img = ensureSvgLoaded(wq, wr)
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
        }
      } else {
        // Empty cell: inset border so it doesn't bleed into neighbors
        hexPathInset(ctx, layout, cx, cy, inset)
        ctx.strokeStyle = '#222'
        ctx.lineWidth = 0.5 / camera.zoom
        ctx.stroke()
      }
    }
  }

  // Highlight selected cell
  if (selectedTile) {
    // Find the nearest world-space instance of the selected tile
    const sq = selectedTile.q, sr = selectedTile.r
    // Use the instance closest to current viewport center
    const ctrQ = Math.round(camera.x / layout.colStep)
    const ctrR = Math.round(camera.y / layout.rowStep)
    const bestQ = ctrQ - (((ctrQ - sq) % GRID_SIZE) + GRID_SIZE) % GRID_SIZE
    const bestR = ctrR - (((ctrR - sr) % GRID_SIZE) + GRID_SIZE) % GRID_SIZE
    const [scx, scy] = hexToPixel(layout, bestQ, bestR)
    hexPath(ctx, layout, scx, scy)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2 / camera.zoom
    ctx.stroke()
  }

  // Highlight hovered cell (use raw world coords for drawing)
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

  // HUD: coords + tile info
  ctx.fillStyle = '#888'
  ctx.font = '13px system-ui'
  if (hovered) {
    const tile = getTile(hovered.q, hovered.r)
    let text = `(${hovered.q}, ${hovered.r})`
    if (tile) {
      text += `  family ${tile.ka}-${tile.kb}-${tile.kc}  idx ${tile.catalanIndex}`
    }
    ctx.fillText(text, 12, h - 12)
  }
}

// ── Interaction: pan, zoom, hover ──

let dragging = false
let didDrag = false
let lastMouse = { x: 0, y: 0 }
let downMouse = { x: 0, y: 0 }
/** Hovered cell: q,r are wrapped [0,511], wq,wr are raw world-space coords for drawing. */
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
  } else {
    // Hover detection — pixelToHex returns wrapped coords, but we also
    // need the raw world-space column/row for drawing the highlight.
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
    // Click on a cell — show tile info panel
    showTilePanel(hovered.q, hovered.r)
    // Update hash without triggering hashchange focus
    history.replaceState(null, '', `#tile=${hovered.q},${hovered.r}`)
  }
})

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const factor = e.deltaY > 0 ? 0.9 : 1.1
  const newZoom = Math.min(Math.max(camera.zoom * factor, minZoom()), 10)

  // Zoom toward cursor
  const [wx, wy] = screenToWorld(e.clientX, e.clientY)
  camera.zoom = newZoom
  const [wx2, wy2] = screenToWorld(e.clientX, e.clientY)
  camera.x -= wx2 - wx
  camera.y -= wy2 - wy

  draw()
}, { passive: false })

// ── Tile info panel ──

const tilePanel = document.createElement('div')
tilePanel.className = 'tile-panel'
tilePanel.style.display = 'none'
document.body.appendChild(tilePanel)

let selectedTile: { q: number; r: number } | null = null

function shortAddr(addr: string): string {
  if (!addr || addr === '0x' + '0'.repeat(40)) return 'unowned'
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

function closeTilePanel() {
  tilePanel.style.display = 'none'
  selectedTile = null
  draw()
}

function showTilePanel(q: number, r: number) {
  selectedTile = { q, r }
  const tile = getTile(q, r)
  const tokenId = tokenIdOf(q, r)

  let html = `<button class="tile-panel-close">&times;</button>`
  html += `<div class="tile-panel-title">Tile (${q}, ${r})</div>`
  html += `<div class="tile-panel-field"><span class="tile-panel-label">Token ID</span><span class="tile-panel-value">${tokenId}</span></div>`

  if (tile) {
    html += `<div class="tile-panel-field"><span class="tile-panel-label">Family</span><span class="tile-panel-value">${tile.ka}-${tile.kb}-${tile.kc}</span></div>`
    html += `<div class="tile-panel-field"><span class="tile-panel-label">Catalan index</span><span class="tile-panel-value">${tile.catalanIndex}</span></div>`
  } else {
    html += `<div class="tile-panel-empty">Empty cell</div>`
  }

  // On-chain data placeholder (filled async)
  html += `<div class="tile-panel-chain" id="tile-chain-data">`
  if (isConnected() && NFT_ADDRESS) {
    html += `<span class="tile-panel-loading">Loading on-chain data...</span>`
  } else {
    html += `<span class="tile-panel-loading">Connect wallet to view on-chain data</span>`
  }
  html += `</div>`

  // Explorer link
  if (NFT_ADDRESS) {
    html += `<a class="tile-panel-explorer" href="${BLOCK_EXPLORER}/token/${NFT_ADDRESS}?a=${tokenId}" target="_blank" rel="noopener">View on explorer</a>`
  }

  // Share link
  html += `<a class="tile-panel-link" href="#tile=${q},${r}">Permalink</a>`

  tilePanel.innerHTML = html
  tilePanel.style.display = ''

  tilePanel.querySelector('.tile-panel-close')?.addEventListener('click', closeTilePanel)

  // Fetch on-chain data
  if (isConnected() && NFT_ADDRESS) {
    fetchTile(q, r).then((onChain: OnChainTile) => {
      // Check we're still showing the same tile
      if (!selectedTile || selectedTile.q !== q || selectedTile.r !== r) return
      const el = document.getElementById('tile-chain-data')
      if (!el) return

      const zeroAddr = '0x' + '0'.repeat(40)
      const owned = onChain.tileOwner !== zeroAddr

      let chainHtml = ''
      if (owned) {
        chainHtml += `<div class="tile-panel-field"><span class="tile-panel-label">Owner</span><span class="tile-panel-value mono" title="${onChain.tileOwner}">${shortAddr(onChain.tileOwner)}</span></div>`
        chainHtml += `<div class="tile-panel-field"><span class="tile-panel-label">Polarity</span><span class="tile-panel-value">${onChain.polarity ? '+' : '-'}</span></div>`
        chainHtml += `<div class="tile-panel-field"><span class="tile-panel-label">Family (chain)</span><span class="tile-panel-value">${onChain.ka}-${onChain.kb}-${onChain.kc}</span></div>`
      } else {
        chainHtml += `<div class="tile-panel-field"><span class="tile-panel-label">Status</span><span class="tile-panel-value">Not minted</span></div>`
      }
      el.innerHTML = chainHtml
    }).catch((err: unknown) => {
      const el = document.getElementById('tile-chain-data')
      if (el) el.innerHTML = `<span class="tile-panel-error">Failed to load</span>`
      console.warn('fetchTile error:', err)
    })
  }

  draw()
}

// ── Hash-based tile focus: #tile=q,r ──

/** Parse #tile=q,r from the URL hash. Returns [q, r] or null. */
function parseTileHash(): [number, number] | null {
  const m = location.hash.match(/^#tile=(\d+),(\d+)$/)
  if (!m) return null
  const q = parseInt(m[1], 10)
  const r = parseInt(m[2], 10)
  if (q < 0 || q >= GRID_SIZE || r < 0 || r >= GRID_SIZE) return null
  return [q, r]
}

/** Focus camera on tile (q, r), zoomed so the hex fills at most 1/3 of viewport. */
function focusTile(q: number, r: number) {
  const [px, py] = hexToPixel(layout, q, r)
  camera.x = px
  camera.y = py
  // Zoom so the hex spans 1/3 of viewport width or height (whichever is tighter)
  const vw = canvas.clientWidth || 1
  const vh = canvas.clientHeight || 1
  camera.zoom = Math.min(vw / (3 * layout.width), vh / (3 * layout.height))
}

// ── Init ──

// Center camera on grid origin (0,0)
camera.x = 0
camera.y = 0

initMenu()
setOnUpdate(draw)
window.addEventListener('resize', resize)
resize()
loadGrid().then(() => {
  const tile = parseTileHash()
  if (tile) focusTile(tile[0], tile[1])
  draw()
})

// Re-focus when hash changes (e.g. user edits URL or clicks a link)
window.addEventListener('hashchange', () => {
  const tile = parseTileHash()
  if (tile) {
    focusTile(tile[0], tile[1])
    draw()
  }
})
