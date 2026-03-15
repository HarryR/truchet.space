import { defineConfig, type Plugin, loadEnv } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { visualizer } from 'rollup-plugin-visualizer'

const REQUIRED_ENV = [
  'VITE_CHAIN_ID',
  'VITE_RPC_URL',
  'VITE_NFT_ADDRESS',
  'VITE_GATE_ADDRESS',
  'VITE_USDC_ADDRESS',
  'VITE_BLOCK_EXPLORER',
  'VITE_TILE_CDN',
]

function envCheck(): Plugin {
  return {
    name: 'env-check',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir ?? process.cwd(), 'VITE_')
      const missing = REQUIRED_ENV.filter(k => !env[k])
      if (missing.length > 0) {
        throw new Error(`Missing required env vars:\n  ${missing.join('\n  ')}`)
      }
    },
  }
}

export default defineConfig({
  build: {
    target: 'es2022',
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2 },
    },
  },
  plugins: [
    envCheck(),
    viteSingleFile(),
    visualizer({
      filename: 'dist/stats.html',
      gzipSize: true,
      template: 'treemap',
    }),
  ],
})
