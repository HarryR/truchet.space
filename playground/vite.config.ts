import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Output: dist/index.html (all JS, CSS and the solver worker inlined)
// plus dist/truchet_svg.wasm, copied from public/ and fetched at runtime.
export default defineConfig({
  build: {
    target: 'es2022',
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2 },
    },
  },
  // Dev/preview from a phone over Tailscale: listen on all interfaces and
  // accept *.ts.net host names.
  server: { host: true, allowedHosts: ['.ts.net'] },
  preview: { host: true, allowedHosts: ['.ts.net'] },
  worker: {
    format: 'es',
  },
  // Relative base: works at a domain root or under a sub-path without rebuilding.
  base: './',
  plugins: [viteSingleFile()],
})
