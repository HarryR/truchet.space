/**
 * Top menu bar — logo + wallet connect button + wallet dialog.
 */

import { el_div, el_button, field } from './html'
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
  dialog.className = 'wallet-dialog panel'
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

    let html = el_button( 'panel-close', '&times;', ' aria-label="Close"')

    if (addr) {
      html += el_div( 'panel-title', mediumAddr(addr), ` title="${addr}"`)

      const cid = getChainId()
      const chainName = getChainName(cid)
      const onCorrectChain = isCorrectChain()
      const wrongClass = onCorrectChain ? '' : ' wrong-network'
      let networkContent = `<span>${chainName}</span>`
      if (!onCorrectChain) {
        networkContent += el_button( 'wallet-switch-chain', `Switch to ${getChainName(TARGET_CHAIN_ID)}`)
      }
      html += el_div( `wallet-network panel-section${wrongClass}`, networkContent)

      html += el_div( 'wallet-balances panel-section',
        field('ETH', eth !== null ? truncateBalance(eth) : '—') +
        field('USDC', usdc !== null ? truncateBalance(usdc, 2) : '—'))
    }

    if (providers.length > 0) {
      let providersHtml = ''
      for (const p of providers) {
        const isActiveProvider = p.info.rdns === activeRdns
        const providerClass = isActiveProvider ? ' active' : ''
        let groupHtml = el_button( `wallet-provider${providerClass}`,
          `<img class="wallet-provider-icon" src="${p.info.icon}" alt="" width="24" height="24" />` +
          `<span>${p.info.name}</span>`,
          ` data-rdns="${p.info.rdns}"`)

        // Show accounts for this provider if it's the active one
        const accounts = getAccountsForProvider(p.info.rdns)
        if (isActiveProvider && accounts.length > 0) {
          let accountsHtml = ''
          for (const acct of accounts) {
            const isActive = acct.toLowerCase() === addr?.toLowerCase()
            const acctClass = isActive ? ' active' : ''
            accountsHtml += el_button( `wallet-account${acctClass}`, mediumAddr(acct), ` data-address="${acct}" title="${acct}"`)
          }
          groupHtml += el_div( 'wallet-accounts', accountsHtml)
        }

        providersHtml += el_div( 'wallet-provider-group', groupHtml)
      }
      html += el_div( 'wallet-providers', providersHtml)
    }

    if (addr) {
      html += el_button( 'wallet-disconnect', 'Disconnect')
    }

    dialog.innerHTML = html

    // Bind events
    dialog.querySelector('.panel-close')?.addEventListener('click', closeDialog)
    dialog.querySelector('.wallet-switch-chain')?.addEventListener('click', async () => {
      try {
        await ensureCorrectChain()
      } catch (e) {
        console.error('Chain switch failed:', e)
      }
    })
    dialog.querySelector('.wallet-disconnect')?.addEventListener('click', () => {
      disconnect()
      closeDialog()
    })
    for (const btn of dialog.querySelectorAll('.wallet-provider')) {
      btn.addEventListener('click', async () => {
        const rdns = (btn as HTMLElement).dataset.rdns
        try {
          await connect(rdns)
        } catch (e) {
          console.error('Wallet connect failed:', e)
        }
      })
    }
    for (const btn of dialog.querySelectorAll('.wallet-account')) {
      btn.addEventListener('click', () => {
        const acctAddr = (btn as HTMLElement).dataset.address
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
