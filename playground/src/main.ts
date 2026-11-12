import './style.css'
import { SOLVER_MAX_WORKERS } from './config'
import { autosave, loadWorld } from './persist'
import { SolverPool } from './solver/pool'
import { TileCache } from './tiles'
import { Menu } from './ui/menu'
import { Camera } from './view/camera'
import { attachInput } from './view/input'
import { Renderer } from './view/render'
import { World } from './world'

const canvas = document.getElementById('grid') as HTMLCanvasElement
const hud = document.getElementById('hud')!

// ── State ──

const randomSeed = () => Math.floor(Math.random() * 0x1_0000_0000)

const world = new World()
if (!loadWorld(world)) world.reset(randomSeed())
autosave(world)

// ── Solver + tile images ──

const wasmUrl = new URL(`${import.meta.env.BASE_URL}truchet_svg.wasm`, location.href).href
const nWorkers = Math.max(1, Math.min(SOLVER_MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1))
let solverError: string | null = null
const pool = new SolverPool(wasmUrl, nWorkers,
  (key, svg) => tiles.handleResult(key, svg),
  (err) => { solverError = err; console.error('solver:', err); updateHud() })
const tiles = new TileCache(pool)

// ── View ──

const camera = new Camera()
const renderer = new Renderer(canvas, camera, world, tiles, pool)

const menu = new Menu(document.getElementById('menu')!, {
  undo() { world.undo() },
  newWorld() {
    if (world.size > 1 && !confirm('Start a new pattern? The current one will be lost.')) return
    world.reset(randomSeed())
    camera.centerOn(0, 0, 1)
    renderer.request()
  },
})

const syncMenu = () => menu.update(world.size, world.canUndo)
world.subscribe(syncMenu)
syncMenu()

// ── HUD ──

function updateHud() {
  if (solverError) {
    hud.textContent = `Solver failed to load: ${solverError}`
    hud.className = 'error'
    return
  }
  const parts: string[] = []
  const h = renderer.overlay.hovered
  if (h) {
    const [ka, kb, kc] = world.familyAt(h.q, h.r)
    parts.push(`(${h.q}, ${h.r})  ${ka}·${kb}·${kc}`)
  }
  hud.textContent = parts.join('  ·  ')
  hud.className = ''
}
renderer.afterDraw = updateHud

// ── Input ──

attachInput(canvas, camera, {
  onCamera: () => renderer.request(),
  onTap(cell) {
    if (world.canPlace(cell.q, cell.r)) world.place(cell.q, cell.r)
  },
  onHover(cell) {
    const prev = renderer.overlay.hovered
    if (prev?.uq === cell?.uq && prev?.ur === cell?.ur) return
    renderer.overlay.hovered = cell
    renderer.request()
  },
})

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    world.undo()
  }
})

// ── Start ──

window.addEventListener('resize', () => renderer.resize())
renderer.resize()
const first = world.all().next().value
camera.centerOn(first?.q ?? 0, first?.r ?? 0, 1)
renderer.request()
