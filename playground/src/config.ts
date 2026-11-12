/**
 * Static configuration. The playground has no environment-dependent settings.
 */

// XXX: never change this — it is the on-chain torus size and coordinates depend on it.
export const GRID_SIZE = 512

/** Hex size (centre to vertex) in world units. 40 matches the solver's SVG units 1:1. */
export const HEX_SIZE = 40

/** Max visible cells at minimum zoom (controls the zoom-out limit). */
export const MAX_VISIBLE_CELLS = 2500

/** Max zoom-in factor. */
export const MAX_ZOOM = 12

// ── Tile parameters ──

/** Per-axis EP bounds. */
export const EP_MIN = 1
/** Max EP sum ka+kb+kc (the solver's MAX_ARCS). */
export const EP_SUM_MAX = 64

/** Range of the per-line EP counts the pattern wanders through (see lines.ts). */
export const LINE_MIN = 1
export const LINE_MAX = 8

/** Max EP sum deviation (free axes) from any neighbour — mirrors TruchetNFT. */
export const EP_SUM_DELTA = 2

// ── Solver ──

/** Max parallel solver workers. */
export const SOLVER_MAX_WORKERS = 4

/** Max decoded tile images to keep in memory. */
export const TILE_CACHE_MAX = 6000

/** Max bytes of rasterised tile bitmaps to keep (approx; RGBA). */
export const RASTER_CACHE_BYTES = 192 * 1024 * 1024

/** Main-thread budget per frame for rasterising tile images (ms). */
export const RASTER_BUDGET_MS = 6

// ── Persistence ──

export const STORAGE_KEY = 'truchet-playground:v2'
