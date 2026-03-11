/**
 * Top menu bar — logo + wallet connect button + wallet dialog.
 */

import {
  getAddress,
  isConnected,
  connect,
  disconnect,
  selectAccount,
  checkExisting,
  onChange,
  getEthBalance,
  getUsdcBalance,
  getActiveRdns,
  getProviders,
  getAccountsForProvider,
  getChainId,
  getChainName,
  isCorrectChain,
  ensureCorrectChain,
  TARGET_CHAIN_ID,
} from './wallet'

/** Short address for the menu button. */
function shortAddr(addr: string): string {
  return addr.slice(0, 6) + '…' + addr.slice(-4)
}

/** Medium address for the dialog. */
function mediumAddr(addr: string): string {
  return addr.slice(0, 10) + '…' + addr.slice(-8)
}

function truncateBalance(val: string, decimals = 4): string {
  const dot = val.indexOf('.')
  if (dot === -1) return val
  return val.slice(0, dot + decimals + 1)
}

export function initMenu() {
  const bar = document.getElementById('menu')!

  const title = document.createElement('span')
  title.className = 'menu-title'
  title.textContent = 'truchet.space'
  bar.appendChild(title)

  const btn = document.createElement('button')
  btn.className = 'menu-wallet'
  bar.appendChild(btn)

  // ── Dialog ──

  const overlay = document.createElement('div')
  overlay.className = 'wallet-overlay'
  document.body.appendChild(overlay)

  const dialog = document.createElement('div')
  dialog.className = 'wallet-dialog'
  overlay.appendChild(dialog)

  let dialogOpen = false

  function openDialog() {
    dialogOpen = true
    overlay.classList.add('open')
    renderDialog()
  }

  function closeDialog() {
    dialogOpen = false
    overlay.classList.remove('open')
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog()
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialogOpen) closeDialog()
  })

  function renderDialog() {
    if (!dialogOpen) return

    const addr = getAddress()
    const eth = getEthBalance()
    const usdc = getUsdcBalance()
    const providers = getProviders()
    const activeRdns = getActiveRdns()

    let html = `<button class="wallet-dialog-close" aria-label="Close">&times;</button>`

    if (addr) {
      html += `<div class="wallet-dialog-addr" title="${addr}">${mediumAddr(addr)}</div>`

      const cid = getChainId()
      const chainName = getChainName(cid)
      const onCorrectChain = isCorrectChain()
      const wrongClass = onCorrectChain ? '' : ' wrong-network'
      html += `<div class="wallet-dialog-network${wrongClass}">`
      html += `<span>${chainName}</span>`
      if (!onCorrectChain) {
        html += `<button class="wallet-dialog-switch-chain">Switch to ${getChainName(TARGET_CHAIN_ID)}</button>`
      }
      html += `</div>`

      html += `<div class="wallet-dialog-balances">`
      html += `<div class="wallet-dialog-balance"><span class="balance-label">ETH</span><span class="balance-value">${eth !== null ? truncateBalance(eth) : '—'}</span></div>`
      html += `<div class="wallet-dialog-balance"><span class="balance-label">USDC</span><span class="balance-value">${usdc !== null ? truncateBalance(usdc, 2) : '—'}</span></div>`
      html += `</div>`
    }

    if (providers.length > 0) {
      html += `<div class="wallet-dialog-providers">`
      for (const p of providers) {
        const isActiveProvider = p.info.rdns === activeRdns
        const providerClass = isActiveProvider ? ' active' : ''
        html += `<div class="wallet-dialog-provider-group">`
        html += `<button class="wallet-dialog-provider${providerClass}" data-rdns="${p.info.rdns}">`
        html += `<img class="wallet-dialog-provider-icon" src="${p.info.icon}" alt="" width="24" height="24" />`
        html += `<span>${p.info.name}</span>`
        html += `</button>`

        // Show accounts for this provider if it's the active one
        const accounts = getAccountsForProvider(p.info.rdns)
        if (isActiveProvider && accounts.length > 0) {
          html += `<div class="wallet-dialog-accounts">`
          for (const acct of accounts) {
            const isActive = acct.toLowerCase() === addr?.toLowerCase()
            const acctClass = isActive ? ' active' : ''
            html += `<button class="wallet-dialog-account${acctClass}" data-address="${acct}" title="${acct}">`
            html += mediumAddr(acct)
            html += `</button>`
          }
          html += `</div>`
        }

        html += `</div>`
      }
      html += `</div>`
    }

    if (addr) {
      html += `<button class="wallet-dialog-disconnect">Disconnect</button>`
    }

    dialog.innerHTML = html

    // Bind events
    dialog.querySelector('.wallet-dialog-close')?.addEventListener('click', closeDialog)
    dialog.querySelector('.wallet-dialog-switch-chain')?.addEventListener('click', async () => {
      try {
        await ensureCorrectChain()
      } catch (e) {
        console.error('Chain switch failed:', e)
      }
    })
    dialog.querySelector('.wallet-dialog-disconnect')?.addEventListener('click', () => {
      disconnect()
      closeDialog()
    })
    for (const el of dialog.querySelectorAll('.wallet-dialog-provider')) {
      el.addEventListener('click', async () => {
        const rdns = (el as HTMLElement).dataset.rdns
        try {
          await connect(rdns)
        } catch (e) {
          console.error('Wallet connect failed:', e)
        }
      })
    }
    for (const el of dialog.querySelectorAll('.wallet-dialog-account')) {
      el.addEventListener('click', () => {
        const acctAddr = (el as HTMLElement).dataset.address
        if (acctAddr) selectAccount(acctAddr)
      })
    }
  }

  // ── Button logic ──

  function render() {
    if (isConnected()) {
      btn.textContent = shortAddr(getAddress()!)
      btn.title = getAddress()!
    } else {
      btn.textContent = 'Connect Wallet'
      btn.title = ''
    }
    renderDialog()
  }

  btn.addEventListener('click', async () => {
    if (isConnected()) {
      openDialog()
    } else {
      // If we have EIP-6963 providers, show dialog to pick; otherwise connect directly
      if (getProviders().length > 0) {
        openDialog()
      } else {
        try {
          await connect()
          openDialog()
        } catch (e) {
          console.error('Wallet connect failed:', e)
        }
      }
    }
  })

  onChange(render)
  render()

  // Auto-reconnect existing session
  checkExisting()
}
