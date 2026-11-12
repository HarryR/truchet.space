/**
 * A pool of solver workers with a priority queue.
 *
 * The renderer calls beginFrame() then request() for every tile it would like
 * to draw; jobs not re-requested for a couple of frames (scrolled away) are
 * dropped before they start. Higher priority runs first.
 */

import SolverWorker from './worker?worker&inline'
import { solveKey, type FromWorker, type SolveParams, type ToWorker } from './protocol'

interface Job {
  key: string
  params: SolveParams
  priority: number
  gen: number
}

interface Slot {
  worker: Worker
  ready: boolean
  job: Job | null
  jobId: number
}

export type ResultHandler = (key: string, svg: string | null) => void

export class SolverPool {
  private slots: Slot[] = []
  private queue = new Map<string, Job>()
  private running = new Set<string>()
  private gen = 0
  private nextId = 1
  private totalMs = 0
  private solved = 0
  error: string | null = null
  private onResult: ResultHandler
  private onError: (err: string) => void

  constructor(wasmUrl: string, size: number, onResult: ResultHandler, onError: (err: string) => void) {
    this.onResult = onResult
    this.onError = onError
    for (let i = 0; i < size; i++) {
      const worker = new SolverWorker()
      const slot: Slot = { worker, ready: false, job: null, jobId: 0 }
      worker.onmessage = (ev: MessageEvent<FromWorker>) => this.handle(slot, ev.data)
      worker.onerror = (ev) => this.fail(ev.message || 'worker error')
      worker.postMessage({ type: 'init', wasmUrl } satisfies ToWorker)
      this.slots.push(slot)
    }
  }

  /** Start a new request generation (call once per rendered frame). */
  beginFrame() {
    this.gen++
  }

  /** Ask for a tile. Cheap to call repeatedly; dedups by key. */
  request(params: SolveParams, priority: number) {
    const key = solveKey(params)
    if (this.running.has(key)) return
    const job = this.queue.get(key)
    if (job) {
      job.priority = priority
      job.gen = this.gen
    } else {
      this.queue.set(key, { key, params, priority, gen: this.gen })
    }
    this.pump()
  }

  get pending(): number {
    return this.queue.size + this.running.size
  }

  get avgMs(): number {
    return this.solved ? this.totalMs / this.solved : 0
  }

  private handle(slot: Slot, msg: FromWorker) {
    if (msg.type === 'ready') {
      slot.ready = true
      this.pump()
    } else if (msg.type === 'init-error') {
      this.fail(msg.error)
    } else if (msg.type === 'result') {
      const job = slot.job
      if (!job || msg.id !== slot.jobId) return
      slot.job = null
      this.running.delete(job.key)
      this.totalMs += msg.ms
      this.solved++
      if (msg.error) console.warn('solver error', job.key, msg.error)
      this.onResult(job.key, msg.svg)
      this.pump()
    }
  }

  private fail(err: string) {
    if (this.error) return
    this.error = err
    this.onError(err)
  }

  private pump() {
    for (const slot of this.slots) {
      if (!slot.ready || slot.job) continue
      const job = this.take()
      if (!job) return
      slot.job = job
      slot.jobId = this.nextId++
      this.running.add(job.key)
      const { ka, kb, kc, polarity, idx } = job.params
      slot.worker.postMessage({
        type: 'solve', id: slot.jobId, ka, kb, kc, polarity: polarity ? 1 : 0, idx: idx.toString(),
      } satisfies ToWorker)
    }
  }

  /** Highest-priority live job; drops stale ones. */
  private take(): Job | null {
    let best: Job | null = null
    for (const job of this.queue.values()) {
      if (job.gen < this.gen - 2) {
        this.queue.delete(job.key)
        continue
      }
      if (!best || job.priority > best.priority) best = job
    }
    if (best) this.queue.delete(best.key)
    return best
  }
}
