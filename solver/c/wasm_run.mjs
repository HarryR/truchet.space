// Run truchet.wasm (WASI build, see Makefile `wasm` target) under Node.
//
//   node --experimental-wasi-unstable-preview1 --no-warnings wasm_run.mjs \
//        [--dir=HOSTDIR] shape=hex eps=3,2,1 idx=25 w=1 h=1 svg=/out/t.svg
//
// HOSTDIR (default: cwd) is visible to the solver as /out.
// Prints "wasm: compile X ms, run Y ms" to stderr; the exit code is the solver's.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';

let dir = process.cwd();
const args = process.argv.slice(2).filter((a) => {
  if (a.startsWith('--dir=')) { dir = a.slice(6); return false; }
  return true;
});

const bytes = await readFile(new URL('./truchet.wasm', import.meta.url));
const t0 = performance.now();
const module = await WebAssembly.compile(bytes);
const t1 = performance.now();

const wasi = new WASI({ args: ['truchet', ...args], env: {}, preopens: { '/out': dir } });
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
const t2 = performance.now();
let code = 0;
try {
  code = wasi.start(instance) ?? 0;
} finally {
  console.error(`wasm: compile ${(t1 - t0).toFixed(1)} ms, run ${(performance.now() - t2).toFixed(1)} ms`);
}
process.exitCode = code;
