// EIP-6963: Multi Injected Provider Discovery
// https://eips.ethereum.org/EIPS/eip-6963

export interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
}

export interface EIP6963ProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo
  provider: EIP1193Provider
}

interface EIP6963AnnounceProviderEvent extends CustomEvent {
  detail: EIP6963ProviderDetail
}

const providers = new Map<string, EIP6963ProviderDetail>()
let listening = false

function handleAnnounce(event: Event) {
  const { detail } = event as EIP6963AnnounceProviderEvent
  if (!providers.has(detail.info.uuid)) {
    providers.set(detail.info.uuid, detail)
  }
}

export function startDiscovery() {
  if (listening) return
  window.addEventListener('eip6963:announceProvider', handleAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  listening = true
}

export function stopDiscovery() {
  window.removeEventListener('eip6963:announceProvider', handleAnnounce)
  listening = false
}

export function getProvider(rdns?: string): EIP1193Provider | null {
  if (rdns) {
    for (const detail of providers.values()) {
      if (detail.info.rdns === rdns) return detail.provider
    }
    return null
  }
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null
}

export function getProviders(): EIP6963ProviderDetail[] {
  return Array.from(providers.values())
}
