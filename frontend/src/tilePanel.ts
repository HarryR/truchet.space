/**
 * Tile info panel — shown when clicking a hex cell.
 * Pure renderer: reads from store/grid, no direct RPC calls.
 */

import { isPlaced, getTile } from './grid'
import { neighbor } from './hex'
import {
  tokenIdOf,
  placeTileETH, placeTileUSDC, waitForReceipt,
} from './contracts'
import { isConnected, isCorrectChain, getEthBalance, getUsdcBalance } from './wallet'
import { NFT_ADDRESS, BLOCK_EXPLORER } from './config'
import { formatEther, formatUnits } from './abi'
import { pickCatalanIndex, catalan, nextValidValue, type TileConstraints } from './tileParams'
import { signUsdcAuthorization } from './usdc'
import { el_div, el_span, el_button, field, extLink } from './html'
import * as store from './store'

// ── State ──

let activeMintFlow = false
let renderGeneration = 0
let lastRenderKey: string | null = null

function renderKey(q: number, r: number): string {
  const onChain = store.getOnChainTile(q, r)
  const constraints = store.getConstraints(q, r)
  return `${q},${r}:${isPlaced(q, r)}:${!!getTile(q, r)}:${!!onChain}:${!!constraints}:${isConnected()}:${isCorrectChain()}:${store.getEthPrice()}:${store.getUsdcPrice()}`
}

const tilePanel = document.createElement('div')
tilePanel.className = 'tile-panel panel'
tilePanel.style.display = 'none'
document.body.appendChild(tilePanel)

// ── Public API ──

export function getSelectedTile(): { q: number; r: number } | null {
  return store.getSelectedTile()
}

export function initTilePanel(onChange: () => void) {
  // Subscribe to store for re-renders
  store.subscribe(() => {
    refreshTilePanel()
    onChange()
  })
}

/** Re-render the tile panel if one is currently open and relevant state changed. */
export function refreshTilePanel() {
  const sel = store.getSelectedTile()
  if (!sel || activeMintFlow) return
  const current = renderKey(sel.q, sel.r)
  if (current === lastRenderKey) return
  showTilePanel(sel.q, sel.r)
}

// ── Helpers ──

function shortAddr(addr: string): string {
  if (!addr || addr === '0x' + '0'.repeat(40)) return 'unowned'
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

function closeTilePanel() {
  tilePanel.style.display = 'none'
  store.clearSelection()
  lastRenderKey = null
}

/** Check whether an error represents the user rejecting/denying a wallet prompt.
 *  EIP-1193 defines code 4001 for user rejection; some wallets use 4100 or
 *  ACTION_REJECTED (-32603 sub-error).  Fall back to string matching for
 *  wallets that don't set a proper code. */
function isUserRejection(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>
    // EIP-1193 code 4001 = user rejected, 4100 = unauthorized
    const code = typeof obj.code === 'number' ? obj.code
      : typeof obj.code === 'string' ? parseInt(obj.code, 10) : undefined
    if (code === 4001 || code === 4100) return true
    // ethers.js / nested error shapes
    if (typeof obj.error === 'object' && obj.error !== null) {
      const inner = obj.error as Record<string, unknown>
      if (inner.code === 4001 || inner.code === 4100) return true
    }
  }
  // Fallback: string matching for non-compliant wallets
  const msg = extractErrorMessage(err).toLowerCase()
  return msg.includes('reject') || msg.includes('denied') || msg.includes('user cancel')
}

/** Extract a human-readable message from RPC/wallet errors. */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>
    if (obj.data && typeof obj.data === 'object') {
      const data = obj.data as Record<string, unknown>
      if (typeof data.message === 'string') return data.message
    }
    if (typeof obj.message === 'string') return obj.message
  }
  return String(err)
}

// ── Mint UI ──

type MintState = 'idle' | 'confirming' | 'pending' | 'confirmed' | 'done' | 'error'

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

function renderMintArea(container: HTMLElement, s: MintUIState) {
  const sel = store.getSelectedTile()
  if (!sel || sel.q !== s.q || sel.r !== s.r) return
  let html = ''

  if (s.flowState === 'idle') {
    // EP controls
    let epHtml = ''
    for (let axis = 0; axis < 3; axis++) {
      const free = s.constraints.freeAxes.has(axis)
      const val = s.eps[axis]
      let rowContent = el_span('ep-label', AXIS_NAMES[axis])
      if (free) {
        const canDec = nextValidValue(axis, s.eps, -1, s.constraints) !== null
        const canInc = nextValidValue(axis, s.eps, 1, s.constraints) !== null
        const btnAttrs = (dir: number, enabled: boolean) =>
          ` data-axis="${axis}" data-dir="${dir}"${enabled ? '' : ' disabled'}`
        rowContent += el_button('ep-btn', '-', btnAttrs(-1, canDec))
        rowContent += el_span('ep-val', String(val))
        rowContent += el_button('ep-btn', '+', btnAttrs(1, canInc))
      } else {
        rowContent += el_span('ep-val ep-locked', String(val))
        rowContent += el_span('ep-lock', 'locked')
      }
      epHtml += el_div('ep-row', rowContent)
    }
    const epSum = s.eps[0] + s.eps[1] + s.eps[2]
    const familySize = catalan(epSum)
    epHtml += field('Family size', `C(${epSum}) = ${familySize.toLocaleString()}`, 'panel-value mono')
    html += el_div('ep-controls', epHtml)

    // Prices + balances
    if (s.ethPrice !== null) {
      html += field('ETH price', `${formatEther(s.ethPrice)} ETH`, 'panel-value mono')
    }
    if (s.usdcPrice !== null) {
      html += field('USDC price', `${formatUnits(s.usdcPrice, 6)} USDC`, 'panel-value mono')
    }

    // Buttons
    const connected = isConnected()
    const correctChain = isCorrectChain()
    if (!connected) {
      html += el_button('mint-btn', 'Connect wallet', ' disabled')
    } else if (!correctChain) {
      html += el_button('mint-btn', 'Switch network', ' disabled')
    } else {
      const ethBal = getEthBalance()
      const usdcBal = getUsdcBalance()
      const ethDisabled = s.ethPrice !== null && ethBal !== null && parseFloat(ethBal) < parseFloat(formatEther(s.ethPrice))
      const usdcDisabled = s.usdcPrice !== null && usdcBal !== null && parseFloat(usdcBal) < parseFloat(formatUnits(s.usdcPrice, 6))
      html += el_button('mint-btn', 'Mint with ETH', ` id="mint-eth-btn"${ethDisabled ? ' disabled title="Insufficient ETH"' : ''}`)
      html += el_button('mint-btn', 'Mint with USDC', ` id="mint-usdc-btn"${usdcDisabled ? ' disabled title="Insufficient USDC"' : ''}`)
    }
  } else if (s.flowState === 'confirming') {
    html = field('Status', 'confirm in wallet')
  } else if (s.flowState === 'pending') {
    const value = s.txHash
      ? extLink('panel-value', `${BLOCK_EXPLORER}/tx/${s.txHash}`, 'minting')
      : el_span('panel-value', 'minting')
    html = el_div('panel-field', el_span('panel-label', 'Status') + value)
  } else if (s.flowState === 'confirmed') {
    const value = s.txHash
      ? extLink('panel-value', `${BLOCK_EXPLORER}/tx/${s.txHash}`, 'minted')
      : el_span('panel-value', 'minted')
    html = el_div('panel-field', el_span('panel-label', 'Status') + value)
  } else if (s.flowState === 'error') {
    html = field('Status', s.errorMsg ?? 'Unknown error', 'panel-value panel-error')
    html += el_button('mint-btn', 'Try again', ' id="mint-retry-btn"')
  }

  container.innerHTML = html

  // Hide the on-chain "Not minted" status when mint flow shows its own status
  const chainStatus = document.getElementById('tile-chain-status')
  if (chainStatus) chainStatus.style.display = s.flowState === 'idle' ? '' : 'none'

  // Bind EP stepper buttons
  if (s.flowState === 'idle') {
    for (const btn of container.querySelectorAll<HTMLButtonElement>('.ep-btn')) {
      btn.addEventListener('click', () => {
        const axis = Number(btn.dataset.axis)
        const dir = Number(btn.dataset.dir) as 1 | -1
        const next = nextValidValue(axis, s.eps, dir, s.constraints)
        if (next !== null) s.eps[axis] = next
        renderMintArea(container, s)
        bindMintButtons(container, s)
      })
    }
  }
}

async function runMintFlow(s: MintUIState, method: 'eth' | 'usdc') {
  const mintEl = document.getElementById('tile-mint-area')
  if (!mintEl) return

  activeMintFlow = true
  const { q, r, eps } = s
  const [ka, kb, kc] = eps

  try {
    s.flowState = 'confirming'
    renderMintArea(mintEl, s)

    const catalanIndex = await pickCatalanIndex(ka, kb, kc)
    console.log(`Mint (${q},${r}): ka=${ka} kb=${kb} kc=${kc} idx=${catalanIndex}`)

    let txHash: string
    if (method === 'eth') {
      txHash = await placeTileETH(q, r, ka, kb, kc, catalanIndex)
    } else {
      const price = s.usdcPrice ?? (await store.fetchPrices()).usdc
      if (!price) throw new Error('Could not fetch USDC price')
      const auth = await signUsdcAuthorization(price)
      txHash = await placeTileUSDC(
        auth.from, q, r, ka, kb, kc, catalanIndex,
        auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s,
      )
    }

    s.flowState = 'pending'
    s.txHash = txHash
    renderMintArea(mintEl, s)

    const receipt = await waitForReceipt(txHash)
    if (!receipt.status) {
      activeMintFlow = false
      s.flowState = 'error'
      s.errorMsg = 'Transaction reverted'
      renderMintArea(mintEl, s)
      return
    }

    s.flowState = 'confirmed'
    renderMintArea(mintEl, s)
    store.invalidateTile(q, r)
    await store.awaitTilePlacement(q, r)

    activeMintFlow = false
    showTilePanel(q, r)
  } catch (err: unknown) {
    console.error('Mint error:', err)
    if (isUserRejection(err)) {
      activeMintFlow = false
      s.flowState = 'idle'
      renderMintArea(mintEl, s)
      bindMintButtons(mintEl, s)
      return
    }
    activeMintFlow = false
    s.flowState = 'error'
    s.errorMsg = extractErrorMessage(err)
    renderMintArea(mintEl, s)
    document.getElementById('mint-retry-btn')?.addEventListener('click', () => {
      s.flowState = 'idle'
      s.errorMsg = null
      s.txHash = null
      renderMintArea(mintEl, s)
      bindMintButtons(mintEl, s)
    })
  }
}

function bindMintButtons(_container: HTMLElement, s: MintUIState) {
  document.getElementById('mint-eth-btn')?.addEventListener('click', () => {
    runMintFlow(s, 'eth')
  })
  document.getElementById('mint-usdc-btn')?.addEventListener('click', () => {
    runMintFlow(s, 'usdc')
  })
}

// ── Main panel render ──

export function showTilePanel(q: number, r: number) {
  const gen = ++renderGeneration
  store.selectTile(q, r)
  lastRenderKey = renderKey(q, r)
  const placed = isPlaced(q, r)
  const tokenId = tokenIdOf(q, r)
  const cached = getTile(q, r)

  let html = el_button('panel-close', '&times;')
  html += `<a class="panel-title" href="#tile=${q},${r}">Tile (${q}, ${r})</a>`
  html += field('Token ID', String(tokenId))

  // Metadata from SVG (free, always available once loaded)
  html += `<div id="tile-metadata">`
  if (placed) {
    if (cached) {
      html += field('Family', `${cached.ka}-${cached.kb}-${cached.kc}`)
      html += field('Catalan index', String(cached.catalanIndex))
      html += field('Polarity', cached.polarity ? 'positive' : 'negative')
      if (cached.minter) {
        html += el_div('panel-field',
          el_span('panel-label', 'Minter') +
          el_span('panel-value mono', shortAddr(cached.minter), ` title="${cached.minter}"`))
      }
    } else {
      html += el_span('panel-loading', 'Loading metadata...')
    }
  } else {
    html += el_div('panel-empty', 'Empty cell')
  }
  html += `</div>`

  // On-chain data (wallet connected only — shows current owner, confirms freshness)
  html += `<div class="panel-divider" id="tile-chain-data">`
  if (isConnected()) {
    const onChain = store.getOnChainTile(q, r)
    if (onChain) {
      html += renderChainData(onChain)
    } else {
      html += el_span('panel-loading', 'Loading on-chain data...')
      // Kick off RPC fetch — store.subscribe will re-render when data arrives
      store.fetchTileData(q, r).catch(() => {})
    }
  }
  html += `</div>`

  // Mint area (wallet connected + empty cell + adjacent to placed)
  html += `<div id="tile-mint-area"></div>`

  // Explorer link
  html += `<div id="tile-explorer-link">`
  if (placed) {
    html += extLink('panel-link', `${BLOCK_EXPLORER}/token/${NFT_ADDRESS}?a=${tokenId}`, 'View on explorer')
  }
  html += `</div>`

  tilePanel.innerHTML = html
  tilePanel.style.display = ''

  tilePanel.querySelector('.panel-close')?.addEventListener('click', closeTilePanel)

  // If placed and no metadata yet, fetch from CDN
  if (placed && !cached) {
    store.fetchMetadata(q, r).then(tile => {
      if (gen !== renderGeneration) return
      const metaEl = document.getElementById('tile-metadata')
      if (!metaEl) return
      if (tile) {
        metaEl.innerHTML =
          field('Family', `${tile.ka}-${tile.kb}-${tile.kc}`) +
          field('Catalan index', String(tile.catalanIndex)) +
          field('Polarity', tile.polarity ? 'positive' : 'negative') +
          (tile.minter ? el_div('panel-field',
            el_span('panel-label', 'Minter') +
            el_span('panel-value mono', shortAddr(tile.minter), ` title="${tile.minter}"`)) : '')
      } else {
        metaEl.innerHTML = el_span('panel-error', 'Metadata unavailable')
      }
    })
  }

  // Mint controls for empty frontier cells
  setupMintControls(q, r)
}

/** Set up mint controls for an empty frontier cell (wallet connected, on-chain confirmed empty). */
function setupMintControls(q: number, r: number) {
  if (isPlaced(q, r)) return
  if (!isConnected()) return

  // Need on-chain confirmation that cell is empty
  const onChain = store.getOnChainTile(q, r)
  if (!onChain) return // waiting for RPC
  const zeroAddr = '0x' + '0'.repeat(40)
  if (onChain.tileOwner !== zeroAddr) return // already owned

  // Check if frontier cell (adjacent to placed)
  let hasAdjacentTile = false
  for (let edge = 0; edge < 6; edge++) {
    const { q: nq, r: nr } = neighbor(q, r, edge)
    if (isPlaced(nq, nr)) { hasAdjacentTile = true; break }
  }
  if (!hasAdjacentTile) return

  const constraints = store.computeConstraints(q, r)
  if (!constraints) {
    const mintEl = document.getElementById('tile-mint-area')
    if (mintEl) mintEl.innerHTML = el_div('panel-loading', 'Loading constraints...')
    return
  }

  // Fetch prices if not cached
  if (store.getEthPrice() === null || store.getUsdcPrice() === null) {
    store.fetchPrices().catch(() => {})
  }

  const mintEl = document.getElementById('tile-mint-area')
  if (!mintEl) return
  const uiState: MintUIState = {
    q, r, constraints,
    eps: [...constraints.defaults],
    ethPrice: store.getEthPrice(),
    usdcPrice: store.getUsdcPrice(),
    flowState: 'idle',
    txHash: null, errorMsg: null,
  }
  renderMintArea(mintEl, uiState)
  bindMintButtons(mintEl, uiState)
}

function renderChainData(onChain: import('./contracts').OnChainTile): string {
  const zeroAddr = '0x' + '0'.repeat(40)
  const owned = onChain.tileOwner !== zeroAddr
  let html = ''

  if (owned) {
    html += el_div('panel-field',
      el_span('panel-label', 'Owner') +
      el_span('panel-value mono', shortAddr(onChain.tileOwner), ` title="${onChain.tileOwner}"`))
  } else {
    html += el_div('panel-field', el_span('panel-label', 'Status') + el_span('panel-value', 'Not minted'), ' id="tile-chain-status"')
  }
  return html
}
