// Call truchet_svg.wasm (the import-free library module) from Node.
//
//   node wasm_svg.mjs KA KB KC POLARITY IDX > tile.svg
//
// Exit code 1 if the module returns no tile. Timing goes to stderr.
// The same few lines work in a browser / Web Worker with fetch() in place
// of readFile().
import { readFile } from 'node:fs/promises';

const [ka, kb, kc, polarity, idxStr] = process.argv.slice(2);
if (idxStr === undefined) {
  console.error('usage: node wasm_svg.mjs KA KB KC POLARITY IDX');
  process.exit(2);
}

const bytes = await readFile(new URL('./truchet_svg.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, {});   // no imports
const { memory, _initialize, truchet_svg } = instance.exports;
_initialize();

const idx = BigInt(idxStr);
const t0 = performance.now();
const r = truchet_svg(+ka, +kb, +kc, +polarity, BigInt.asUintN(64, idx), idx >> 64n);
const ms = performance.now() - t0;

if (r === 0) {
  console.error(`wasm: no tile (${ms.toFixed(1)} ms)`);
  process.exit(1);
}
const [ptr, len] = new Uint32Array(memory.buffer, r, 2);
process.stdout.write(new Uint8Array(memory.buffer, ptr, len));
console.error(`wasm: ${ms.toFixed(1)} ms, ${len} bytes, memory ${(memory.buffer.byteLength / 1048576).toFixed(1)} MB`);
