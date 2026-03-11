/**
 * Hex grid coordinate system — even-q offset, flat-top hexagons.
 * 512×512 toroidal topology (coordinates wrap mod 512).
 *
 * Matches the on-chain layout in TruchetNFT.sol exactly.
 *
 * Coordinates: (q, r) where q = column, r = row, both in [0, 511].
 *
 * Edges numbered 0–5 clockwise from right:
 *   Edge 0 = right       (ka)    Edge 3 = left       (ka)
 *   Edge 1 = bottom-right (kb)   Edge 4 = top-left   (kb)
 *   Edge 2 = bottom-left  (kc)   Edge 5 = top-right  (kc)
 *
 * Neighbor across edge i has facing edge (i+3)%6.
 */

export const GRID_SIZE = 512
const MASK = 511

/** Grid coordinate. */
export interface Hex {
  q: number
  r: number
}

/** Flat-top hex dimensions derived from a chosen hex size (center to vertex). */
export interface HexLayout {
  /** Center-to-vertex distance (the "size"). */
  size: number
  /** Hex width = size * 2. */
  width: number
  /** Hex height = size * sqrt(3). */
  height: number
  /** Horizontal step between columns = width * 3/4. */
  colStep: number
  /** Vertical step between rows = height. */
  rowStep: number
}

export function createLayout(size: number): HexLayout {
  const width = size * 2
  const height = size * Math.sqrt(3)
  return {
    size,
    width,
    height,
    colStep: width * 0.75,
    rowStep: height,
  }
}

/**
 * Convert grid (q, r) to pixel center (x, y).
 * Even-q offset: even columns are "normal", odd columns shift down by half a row.
 */
export function hexToPixel(layout: HexLayout, q: number, r: number): [x: number, y: number] {
  const x = q * layout.colStep
  const y = r * layout.rowStep + (q & 1 ? layout.rowStep * 0.5 : 0)
  return [x, y]
}

/**
 * Convert pixel (x, y) to the nearest grid (q, r).
 * Returns fractional values — round to integers for cell lookup.
 */
export function pixelToHex(layout: HexLayout, px: number, py: number): Hex {
  // Estimate q from x
  const q = px / layout.colStep
  const qRound = Math.round(q)

  // Adjust y for the column offset, then get r
  const yOffset = (qRound & 1) ? layout.rowStep * 0.5 : 0
  const r = (py - yOffset) / layout.rowStep
  const rRound = Math.round(r)

  return { q: ((qRound % GRID_SIZE) + GRID_SIZE) % GRID_SIZE, r: ((rRound % GRID_SIZE) + GRID_SIZE) % GRID_SIZE }
}

/**
 * Flat-top hex corner positions (unit, multiply by size and add center).
 * Corner i is at angle (60° * i), i = 0..5.
 */
const CORNER_ANGLES: readonly number[] = [0, 1, 2, 3, 4, 5].map(i => (Math.PI / 3) * i)

/** Pre-computed unit corner offsets (cos/sin for each angle). */
const CORNER_COS: readonly number[] = CORNER_ANGLES.map(a => Math.cos(a))
const CORNER_SIN: readonly number[] = CORNER_ANGLES.map(a => Math.sin(a))

/** Get the 6 corner points of a flat-top hex centered at (cx, cy). */
export function hexCorners(layout: HexLayout, cx: number, cy: number): [number, number][] {
  return CORNER_ANGLES.map(angle => [
    cx + layout.size * Math.cos(angle),
    cy + layout.size * Math.sin(angle),
  ])
}

/** Draw a hex outline on a canvas context. Does not stroke/fill — just builds the path. Zero allocations. */
export function hexPath(ctx: CanvasRenderingContext2D, layout: HexLayout, cx: number, cy: number) {
  const s = layout.size
  ctx.beginPath()
  ctx.moveTo(cx + s * CORNER_COS[0], cy + s * CORNER_SIN[0])
  for (let i = 1; i < 6; i++) {
    ctx.lineTo(cx + s * CORNER_COS[i], cy + s * CORNER_SIN[i])
  }
  ctx.closePath()
}

/** Draw a hex path inset by `inset` pixels toward the center. */
export function hexPathInset(ctx: CanvasRenderingContext2D, layout: HexLayout, cx: number, cy: number, inset: number) {
  const s = layout.size - inset
  ctx.beginPath()
  ctx.moveTo(cx + s * CORNER_COS[0], cy + s * CORNER_SIN[0])
  for (let i = 1; i < 6; i++) {
    ctx.lineTo(cx + s * CORNER_COS[i], cy + s * CORNER_SIN[i])
  }
  ctx.closePath()
}

// ── Neighbor lookup (matches TruchetNFT._neighbor exactly) ──

/**
 * Returns the neighbor of (q, r) across the given edge (0–5).
 * Matches the on-chain _neighbor() function exactly.
 */
export function neighbor(q: number, r: number, edge: number): Hex {
  const even = (q & 1) === 0
  // Use + MASK instead of - 1 to avoid underflow: (x + 511) & 511 == (x - 1) mod 512
  let nq: number, nr: number
  switch (edge) {
    case 0: nq = q + 1;    nr = even ? r : r + 1;        break
    case 1: nq = q;        nr = r + 1;                    break
    case 2: nq = q + MASK; nr = even ? r : r + 1;         break
    case 3: nq = q + MASK; nr = even ? r + MASK : r;      break
    case 4: nq = q;        nr = r + MASK;                 break
    case 5: nq = q + 1;    nr = even ? r + MASK : r;      break
    default: throw new Error(`invalid edge: ${edge}`)
  }
  return { q: nq & MASK, r: nr & MASK }
}

/** All 6 neighbors of (q, r). */
export function neighbors(q: number, r: number): Hex[] {
  return [0, 1, 2, 3, 4, 5].map(e => neighbor(q, r, e))
}

/** The facing edge on a neighbor across edge i is (i+3)%6. */
export function facingEdge(edge: number): number {
  return (edge + 3) % 6
}

/** Pack (q, r) into a tokenId-style key: (q << 9) | r (matches on-chain). */
export function cellKey(q: number, r: number): bigint {
  return (BigInt(q & MASK) << 9n) | BigInt(r & MASK)
}

/** Unpack a cell key back to (q, r). */
export function fromCellKey(key: bigint): Hex {
  return {
    q: Number((key >> 9n) & BigInt(MASK)),
    r: Number(key & BigInt(MASK)),
  }
}

/** Edge index to EP parameter: edges 0,3 → ka; edges 1,4 → kb; edges 2,5 → kc. */
export function edgeParam(edge: number): 'ka' | 'kb' | 'kc' {
  const idx = edge % 3
  if (idx === 0) return 'ka'
  if (idx === 1) return 'kb'
  return 'kc'
}
