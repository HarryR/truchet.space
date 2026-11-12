/** Messages between the main thread and solver workers. */

export interface SolveParams {
  ka: number
  kb: number
  kc: number
  polarity: boolean
  idx: bigint
}

export type ToWorker =
  | { type: 'init'; wasmUrl: string }
  | { type: 'solve'; id: number; ka: number; kb: number; kc: number; polarity: number; idx: string }

export type FromWorker =
  | { type: 'ready' }
  | { type: 'init-error'; error: string }
  | { type: 'result'; id: number; svg: string | null; ms: number; error?: string }

/** Cache / dedup key for a tile's SVG — it depends only on these five values. */
export function solveKey(p: SolveParams): string {
  return `${p.ka}.${p.kb}.${p.kc}.${p.polarity ? 1 : 0}.${p.idx}`
}
