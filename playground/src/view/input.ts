/**
 * Pointer / wheel / keyboard input for the grid canvas.
 *
 * - One pointer: drag to pan; a press that doesn't move is a tap (select).
 * - Two pointers: pinch to zoom about the midpoint, and pan with it.
 * - Wheel / trackpad: zoom about the cursor (ctrl+wheel = trackpad pinch).
 * - Mouse hover reports the cell under the cursor (not for touch/pen).
 */

import type { Camera, Cell } from './camera'

export interface InputHandlers {
  /** Camera moved — redraw. */
  onCamera(): void
  onTap(cell: Cell): void
  onHover(cell: Cell | null): void
}

const TAP_SLOP: Record<string, number> = { mouse: 4, pen: 8, touch: 10 }

export function attachInput(canvas: HTMLCanvasElement, camera: Camera, h: InputHandlers) {
  const pointers = new Map<number, { x: number; y: number }>()
  let tapCandidate: { id: number; x: number; y: number; slop: number } | null = null
  let pinch: { dist: number; mx: number; my: number } | null = null

  const local = (e: PointerEvent | WheelEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  const pinchState = () => {
    const [a, b] = [...pointers.values()]
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const [x, y] = local(e)
    canvas.setPointerCapture(e.pointerId)
    pointers.set(e.pointerId, { x, y })
    if (pointers.size === 1) {
      tapCandidate = { id: e.pointerId, x, y, slop: TAP_SLOP[e.pointerType] ?? 6 }
    } else {
      tapCandidate = null
      if (pointers.size === 2) pinch = pinchState()
    }
  })

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e)
    const p = pointers.get(e.pointerId)
    if (!p) {
      if (e.pointerType === 'mouse') h.onHover(camera.pick(x, y))
      return
    }
    if (tapCandidate && tapCandidate.id === e.pointerId &&
        Math.hypot(x - tapCandidate.x, y - tapCandidate.y) > tapCandidate.slop) {
      tapCandidate = null
    }
    if (pointers.size === 2 && pinch) {
      p.x = x; p.y = y
      const next = pinchState()
      camera.panBy(next.mx - pinch.mx, next.my - pinch.my)
      camera.zoomAt(next.mx, next.my, next.dist / pinch.dist)
      pinch = next
      h.onCamera()
    } else if (pointers.size === 1 && !tapCandidate) {
      camera.panBy(x - p.x, y - p.y)
      p.x = x; p.y = y
      h.onCamera()
    } else {
      p.x = x; p.y = y
    }
  })

  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!pointers.has(e.pointerId)) return
    pointers.delete(e.pointerId)
    if (!cancelled && tapCandidate?.id === e.pointerId) {
      const [x, y] = local(e)
      h.onTap(camera.pick(x, y))
    }
    tapCandidate = null
    pinch = pointers.size === 2 ? pinchState() : null
  }
  canvas.addEventListener('pointerup', (e) => end(e, false))
  canvas.addEventListener('pointercancel', (e) => end(e, true))
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !pointers.has(e.pointerId)) h.onHover(null)
  })

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const [x, y] = local(e)
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1
    const dy = e.deltaY * unit
    // ctrl+wheel is how browsers report a trackpad pinch: much smaller deltas.
    camera.zoomAt(x, y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)))
    h.onCamera()
  }, { passive: false })

  // Keyboard: arrows / WASD pan, +/- zoom.
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const step = 120
    const cx = camera.width / 2, cy = camera.height / 2
    switch (e.key) {
      case 'ArrowLeft': case 'a': camera.panBy(step, 0); break
      case 'ArrowRight': case 'd': camera.panBy(-step, 0); break
      case 'ArrowUp': case 'w': camera.panBy(0, step); break
      case 'ArrowDown': case 's': camera.panBy(0, -step); break
      case '+': case '=': camera.zoomAt(cx, cy, 1.25); break
      case '-': case '_': camera.zoomAt(cx, cy, 0.8); break
      default: return
    }
    e.preventDefault()
    h.onCamera()
  })
}
