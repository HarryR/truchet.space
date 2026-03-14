import './style.css'
import { createLayout, hexToPixel, hexPath, hexPathInset, pixelToHex, GRID_SIZE, MASK, neighbor } from './hex'
import { getTile, fetchMetadata, ensureSvgLoaded, setOnUpdate, isPlaced, awaitTilePlacement, refreshBitmap, refreshFrontier, queueConstraintAnalysis } from './grid'
import { initMenu } from './menu'
import {
  fetchTile, fetchPriceETH, fetchPriceUSDC, tokenIdOf,
  placeTileETH, placeTileUSDC, waitForReceipt,
} from './contracts'
import { isConnected, isCorrectChain, getEthBalance, getUsdcBalance } from './wallet'
import { NFT_ADDRESS, BLOCK_EXPLORER } from './config'
import { formatEther, formatUnits } from './abi'
import { computeConstraints, pickCatalanIndex, catalan, nextValidValue, type TileConstraints } from './tileParams'
import { signUsdcAuthorization } from './usdc'

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
  scheduleViewportRefresh()
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
    const placed = isPlaced(hovered.q, hovered.r)
    let text = `(${hovered.q}, ${hovered.r})`
    if (placed) text += '  placed'
    ctx.fillText(text, 12, h - 12)
  }
}

// ── Occupancy bitmap refresh ──

let viewportDebounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleViewportRefresh() {
  if (viewportDebounceTimer !== null) clearTimeout(viewportDebounceTimer)
  viewportDebounceTimer = setTimeout(() => {
    viewportDebounceTimer = null
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const pad = layout.width
    const [wx0, wy0] = screenToWorld(-pad, -pad)
    const [wx1, wy1] = screenToWorld(w + pad, h + pad)
    const qMin = Math.floor(wx0 / layout.colStep) - 1
    const qMax = Math.ceil(wx1 / layout.colStep) + 1
    const rMin = Math.floor(wy0 / layout.rowStep) - 1
    const rMax = Math.ceil(wy1 / layout.rowStep) + 1
    refreshBitmap(qMin, qMax, rMin, rMax).then(() => {
      queueConstraintAnalysis(qMin, qMax, rMin, rMax)
    })
  }, 200)
}

// Periodic frontier refresh (every 12 seconds, only when wallet connected)
setInterval(() => {
  if (isConnected()) refreshFrontier()
}, 12_000)

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
    scheduleViewportRefresh()
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
  scheduleViewportRefresh()
}, { passive: false })

// ── Tile info panel ──

const tilePanel = document.createElement('div')
tilePanel.className = 'tile-panel panel'
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

/** Extract a human-readable message from RPC/MetaMask errors (which are plain objects, not Error instances). */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>
    // MetaMask wraps revert data in data.message or data.data.message
    if (obj.data && typeof obj.data === 'object') {
      const data = obj.data as Record<string, unknown>
      if (typeof data.message === 'string') return data.message
    }
    if (typeof obj.message === 'string') return obj.message
  }
  return String(err)
}

type MintState = 'idle' | 'confirming' | 'pending' | 'confirmed' | 'done' | 'error'


// ── Mint UI state held across renders ──
interface MintUIState {
  q: number
  r: number
  constraints: TileConstraints
  eps: [number, number, number]
  ethPrice: bigint | null
  usdcPrice: bigint | null
  flowState: MintState
  txHash: string | null
  errorMsg: string | null
}

const AXIS_NAMES = ['ka', 'kb', 'kc']

function renderMintArea(el: HTMLElement, s: MintUIState) {
  if (!selectedTile || selectedTile.q !== s.q || selectedTile.r !== s.r) return
  let html = ''

  if (s.flowState === 'idle') {
    // EP controls
    html += `<div class="ep-controls">`
    for (let axis = 0; axis < 3; axis++) {
      const free = s.constraints.freeAxes.has(axis)
      const val = s.eps[axis]
      html += `<div class="ep-row">`
      html += `<span class="ep-label">${AXIS_NAMES[axis]}</span>`
      if (free) {
        const canDec = nextValidValue(axis, s.eps, -1, s.constraints) !== null
        const canInc = nextValidValue(axis, s.eps, 1, s.constraints) !== null
        html += `<button class="ep-btn" data-axis="${axis}" data-dir="-1"${canDec ? '' : ' disabled'}>-</button>`
        html += `<span class="ep-val">${val}</span>`
        html += `<button class="ep-btn" data-axis="${axis}" data-dir="1"${canInc ? '' : ' disabled'}>+</button>`
      } else {
        html += `<span class="ep-val ep-locked">${val}</span>`
        html += `<span class="ep-lock">locked</span>`
      }
      html += `</div>`
    }
    const epSum = s.eps[0] + s.eps[1] + s.eps[2]
    const familySize = catalan(epSum)
    html += `<div class="panel-field"><span class="panel-label">Family size</span><span class="panel-value mono">C(${epSum}) = ${familySize.toLocaleString()}</span></div>`
    html += `</div>`

    // Prices + balances
    const ethBal = getEthBalance()
    const usdcBal = getUsdcBalance()
    if (s.ethPrice !== null) {
      html += `<div class="panel-field"><span class="panel-label">ETH price</span><span class="panel-value mono">${formatEther(s.ethPrice)} ETH</span></div>`
    }
    if (s.usdcPrice !== null) {
      html += `<div class="panel-field"><span class="panel-label">USDC price</span><span class="panel-value mono">${formatUnits(s.usdcPrice, 6)} USDC</span></div>`
    }

    // Buttons
    const connected = isConnected()
    const correctChain = isCorrectChain()
    if (!connected) {
      html += `<button class="mint-btn" disabled>Connect wallet</button>`
    } else if (!correctChain) {
      html += `<button class="mint-btn" disabled>Switch network</button>`
    } else {
      const ethDisabled = s.ethPrice !== null && ethBal !== null && parseFloat(ethBal) < parseFloat(formatEther(s.ethPrice))
      const usdcDisabled = s.usdcPrice !== null && usdcBal !== null && parseFloat(usdcBal) < parseFloat(formatUnits(s.usdcPrice, 6))
      html += `<button class="mint-btn" id="mint-eth-btn"${ethDisabled ? ' disabled title="Insufficient ETH"' : ''}>Mint with ETH</button>`
      html += `<button class="mint-btn" id="mint-usdc-btn"${usdcDisabled ? ' disabled title="Insufficient USDC"' : ''}>Mint with USDC</button>`
    }
  } else if (s.flowState === 'confirming') {
    html = `<div class="panel-field"><span class="panel-label">Status</span><span class="panel-value">confirm in wallet</span></div>`
  } else if (s.flowState === 'pending') {
    const value = s.txHash
      ? `<a class="panel-value" href="${BLOCK_EXPLORER}/tx/${s.txHash}" target="_blank" rel="noopener">minting</a>`
      : `<span class="panel-value">minting</span>`
    html = `<div class="panel-field"><span class="panel-label">Status</span>${value}</div>`
  } else if (s.flowState === 'confirmed') {
    const value = s.txHash
      ? `<a class="panel-value" href="${BLOCK_EXPLORER}/tx/${s.txHash}" target="_blank" rel="noopener">minted</a>`
      : `<span class="panel-value">minted</span>`
    html = `<div class="panel-field"><span class="panel-label">Status</span>${value}</div>`
  } else if (s.flowState === 'error') {
    html = `<div class="panel-field"><span class="panel-label">Status</span><span class="panel-value panel-error">${s.errorMsg ?? 'Unknown error'}</span></div>`
    html += `<button class="mint-btn" id="mint-retry-btn">Try again</button>`
  }

  el.innerHTML = html

  // Hide the on-chain "Not minted" status when mint flow shows its own status
  const chainStatus = document.getElementById('tile-chain-status')
  if (chainStatus) chainStatus.style.display = s.flowState === 'idle' ? '' : 'none'

  // Bind EP stepper buttons
  if (s.flowState === 'idle') {
    for (const btn of el.querySelectorAll<HTMLButtonElement>('.ep-btn')) {
      btn.addEventListener('click', () => {
        const axis = Number(btn.dataset.axis)
        const dir = Number(btn.dataset.dir) as 1 | -1
        const next = nextValidValue(axis, s.eps, dir, s.constraints)
        if (next !== null) s.eps[axis] = next
        renderMintArea(el, s)
        bindMintButtons(el, s)
      })
    }
  }
}

async function runMintFlow(s: MintUIState, method: 'eth' | 'usdc') {
  const el = document.getElementById('tile-mint-area')
  if (!el) return

  const { q, r, eps } = s
  const [ka, kb, kc] = eps

  try {
    s.flowState = 'confirming'
    renderMintArea(el, s)

    const catalanIndex = await pickCatalanIndex(ka, kb, kc)
    console.log(`Mint (${q},${r}): ka=${ka} kb=${kb} kc=${kc} idx=${catalanIndex}`)

    let txHash: string
    if (method === 'eth') {
      txHash = await placeTileETH(q, r, ka, kb, kc, catalanIndex)
    } else {
      const price = s.usdcPrice ?? await fetchPriceUSDC()
      const auth = await signUsdcAuthorization(price)
      txHash = await placeTileUSDC(
        auth.from, q, r, ka, kb, kc, catalanIndex,
        auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s,
      )
    }

    s.flowState = 'pending'
    s.txHash = txHash
    renderMintArea(el, s)

    const receipt = await waitForReceipt(txHash)
    if (!receipt.status) {
      s.flowState = 'error'
      s.errorMsg = 'Transaction reverted'
      renderMintArea(el, s)
      return
    }

    s.flowState = 'confirmed'
    renderMintArea(el, s)
    await awaitTilePlacement(q, r)

    showTilePanel(q, r)
  } catch (err: unknown) {
    console.error('Mint error:', err)
    const msg = extractErrorMessage(err)
    if (msg.includes('rejected') || msg.includes('denied') || msg.includes('User denied')) {
      s.flowState = 'idle'
      renderMintArea(el, s)
      bindMintButtons(el, s)
      return
    }
    s.flowState = 'error'
    s.errorMsg = msg
    renderMintArea(el, s)
    document.getElementById('mint-retry-btn')?.addEventListener('click', () => {
      s.flowState = 'idle'
      s.errorMsg = null
      s.txHash = null
      renderMintArea(el, s)
      bindMintButtons(el, s)
    })
  }
}

function bindMintButtons(_el: HTMLElement, s: MintUIState) {
  document.getElementById('mint-eth-btn')?.addEventListener('click', () => {
    runMintFlow(s, 'eth')
  })
  document.getElementById('mint-usdc-btn')?.addEventListener('click', () => {
    runMintFlow(s, 'usdc')
  })
}

function showTilePanel(q: number, r: number) {
  selectedTile = { q, r }
  const placed = isPlaced(q, r)
  const tokenId = tokenIdOf(q, r)

  let html = `<button class="panel-close">&times;</button>`
  html += `<a class="panel-title" href="#tile=${q},${r}">Tile (${q}, ${r})</a>`
  html += `<div class="panel-field"><span class="panel-label">Token ID</span><span class="panel-value">${tokenId}</span></div>`

  // Metadata placeholder (filled from CDN JSON)
  html += `<div id="tile-metadata">`
  if (placed) {
    const cached = getTile(q, r)
    if (cached) {
      html += `<div class="panel-field"><span class="panel-label">Family</span><span class="panel-value">${cached.ka}-${cached.kb}-${cached.kc}</span></div>`
      html += `<div class="panel-field"><span class="panel-label">Catalan index</span><span class="panel-value">${cached.catalanIndex}</span></div>`
    } else {
      html += `<span class="panel-loading">Loading metadata...</span>`
    }
  } else {
    html += `<div class="panel-empty">Empty cell</div>`
  }
  html += `</div>`

  // On-chain data placeholder (filled async)
  html += `<div class="panel-divider" id="tile-chain-data">`
  if (isConnected() && NFT_ADDRESS) {
    html += `<span class="panel-loading">Loading on-chain data...</span>`
  }
  html += `</div>`

  // Mint area (filled async for unminted tiles)
  html += `<div id="tile-mint-area"></div>`

  // Explorer link — only shown for minted tiles (populated async)
  html += `<div id="tile-explorer-link"></div>`


  tilePanel.innerHTML = html
  tilePanel.style.display = ''

  tilePanel.querySelector('.panel-close')?.addEventListener('click', closeTilePanel)

  // Fetch JSON metadata from CDN (if placed and not cached)
  if (placed && !getTile(q, r)) {
    fetchMetadata(q, r).then(tile => {
      if (!selectedTile || selectedTile.q !== q || selectedTile.r !== r) return
      const metaEl = document.getElementById('tile-metadata')
      if (!metaEl) return
      if (tile) {
        metaEl.innerHTML =
          `<div class="panel-field"><span class="panel-label">Family</span><span class="panel-value">${tile.ka}-${tile.kb}-${tile.kc}</span></div>` +
          `<div class="panel-field"><span class="panel-label">Catalan index</span><span class="panel-value">${tile.catalanIndex}</span></div>`
      } else {
        metaEl.innerHTML = `<span class="panel-error">Metadata unavailable</span>`
      }
    })
  }

  // Fetch on-chain data (wallet connected only)
  if (isConnected() && NFT_ADDRESS) {
    const zeroAddr = '0x' + '0'.repeat(40)

    // Load on-chain tile data + prices in parallel
    const dataPromise = fetchTile(q, r)
    const ethPricePromise = fetchPriceETH().catch(() => null as bigint | null)
    const usdcPricePromise = fetchPriceUSDC().catch(() => null as bigint | null)

    Promise.all([dataPromise, ethPricePromise, usdcPricePromise]).then(([onChain, ethPrice, usdcPrice]) => {
      if (!selectedTile || selectedTile.q !== q || selectedTile.r !== r) return
      const chainEl = document.getElementById('tile-chain-data')
      const mintEl = document.getElementById('tile-mint-area')
      const explorerEl = document.getElementById('tile-explorer-link')
      if (!chainEl) return

      const owned = onChain.tileOwner !== zeroAddr

      let chainHtml = ''
      if (owned) {
        chainHtml += `<div class="panel-field"><span class="panel-label">Owner</span><span class="panel-value mono" title="${onChain.tileOwner}">${shortAddr(onChain.tileOwner)}</span></div>`
        chainHtml += `<div class="panel-field"><span class="panel-label">Polarity</span><span class="panel-value">${onChain.polarity ? 'positive' : 'negative'}</span></div>`
        chainHtml += `<div class="panel-field"><span class="panel-label">Family (chain)</span><span class="panel-value">${onChain.ka}-${onChain.kb}-${onChain.kc}</span></div>`

        // Show explorer link only for minted tiles
        if (explorerEl) {
          explorerEl.innerHTML = `<a class="panel-link" href="${BLOCK_EXPLORER}/token/${NFT_ADDRESS}?a=${tokenId}" target="_blank" rel="noopener">View on explorer</a>`
        }
      } else {
        chainHtml += `<div class="panel-field" id="tile-chain-status"><span class="panel-label">Status</span><span class="panel-value">Not minted</span></div>`

        // Only show mint controls if cell has at least one adjacent placed tile
        let hasAdjacentTile = false
        for (let edge = 0; edge < 6; edge++) {
          const { q: nq, r: nr } = neighbor(q, r, edge)
          if (isPlaced(nq, nr)) { hasAdjacentTile = true; break }
        }

        if (mintEl && hasAdjacentTile) {
          mintEl.innerHTML = `<div class="panel-loading">Loading constraints...</div>`
          computeConstraints(q, r).then(constraints => {
            if (!selectedTile || selectedTile.q !== q || selectedTile.r !== r) return
            console.log(`Constraints (${q},${r}):`, {
              fixed: constraints.fixed,
              freeAxes: [...constraints.freeAxes],
              defaults: constraints.defaults,
              neighborFreeSums: constraints.neighborFreeSums,
            })
            const uiState: MintUIState = {
              q, r, constraints,
              eps: [...constraints.defaults],
              ethPrice, usdcPrice,
              flowState: 'idle',
              txHash: null, errorMsg: null,
            }
            renderMintArea(mintEl, uiState)
            bindMintButtons(mintEl, uiState)
          }).catch(err => {
            if (mintEl) mintEl.innerHTML = `<div class="panel-loading panel-error">${extractErrorMessage(err)}</div>`
          })
        }
      }
      chainEl.innerHTML = chainHtml
    }).catch((err: unknown) => {
      const el = document.getElementById('tile-chain-data')
      if (el) el.innerHTML = `<span class="panel-error">Failed to load</span>`
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

// Focus on hash tile if present
const hashTile = parseTileHash()
if (hashTile) {
  focusTile(hashTile[0], hashTile[1])
  draw()
}

// Re-focus when hash changes (e.g. user edits URL or clicks a link)
window.addEventListener('hashchange', () => {
  const tile = parseTileHash()
  if (tile) {
    focusTile(tile[0], tile[1])
    draw()
  }
})
