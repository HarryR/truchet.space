/// <reference lib="webworker" />
/**
 * Solver worker: hosts one instance of truchet_svg.wasm (see
 * solver/c/truchet_wasm.c) and answers solve requests one at a time.
 *
 * The module has no imports. truchet_svg() returns a pointer to
 * { u32 svg_ptr; u32 svg_len } that is valid until the next call, so the
 * bytes are decoded (copied) immediately.
 */

import type { FromWorker, ToWorker } from './protocol'

interface Exports {
  memory: WebAssembly.Memory
  _initialize: () => void
  truchet_svg: (ka: number, kb: number, kc: number, polarity: number, idxLo: bigint, idxHi: bigint) => number
}

declare const self: DedicatedWorkerGlobalScope

let module: WebAssembly.Module | null = null
let exports: Exports | null = null
const decoder = new TextDecoder()

function post(msg: FromWorker) {
  self.postMessage(msg)
}

async function compile(url: string): Promise<WebAssembly.Module> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  // compileStreaming needs Content-Type: application/wasm; fall back if the server doesn't send it.
  try {
    return await WebAssembly.compileStreaming(res.clone())
  } catch {
    return await WebAssembly.compile(await res.arrayBuffer())
  }
}

function instantiate() {
  const inst = new WebAssembly.Instance(module!, {})
  exports = inst.exports as unknown as Exports
  exports._initialize()
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data
  if (msg.type === 'init') {
    try {
      module = await compile(msg.wasmUrl)
      instantiate()
      post({ type: 'ready' })
    } catch (err) {
      post({ type: 'init-error', error: String(err) })
    }
    return
  }

  const { id, ka, kb, kc, polarity } = msg
  const t0 = performance.now()
  try {
    if (!exports) throw new Error('solver not initialised')
    const idx = BigInt(msg.idx)
    const p = exports.truchet_svg(ka, kb, kc, polarity, BigInt.asUintN(64, idx), idx >> 64n)
    let svg: string | null = null
    if (p !== 0) {
      const [ptr, len] = new Uint32Array(exports.memory.buffer, p, 2)
      svg = decoder.decode(new Uint8Array(exports.memory.buffer, ptr, len))
    }
    post({ type: 'result', id, svg, ms: performance.now() - t0 })
  } catch (err) {
    // A trap can leave the instance in a bad state: start a fresh one.
    try { instantiate() } catch { exports = null }
    post({ type: 'result', id, svg: null, ms: performance.now() - t0, error: String(err) })
  }
}
