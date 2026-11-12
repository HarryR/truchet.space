/**
 * localStorage persistence for the world (debounced). Storage can be missing
 * or throw (private mode, quota); the app works without it.
 */

import { STORAGE_KEY } from './config'
import type { World } from './world'

export function loadWorld(world: World): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    const { rejected } = world.load(JSON.parse(raw))
    if (rejected) console.warn(`persist: ${rejected} saved tiles failed validation and were dropped`)
    return world.size > 0
  } catch (err) {
    console.warn('persist: could not load saved world', err)
    return false
  }
}

export function autosave(world: World, delayMs = 400) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    timer = null
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(world.toJSON()))
    } catch (err) {
      console.warn('persist: could not save world', err)
    }
  }
  world.subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, delayMs)
  })
  // Don't lose the last tap when the tab is closed or backgrounded (mobile).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) { clearTimeout(timer); save() }
  })
}
