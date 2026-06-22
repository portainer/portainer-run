import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// scripts/dev.mjs sets DEV_API_ORIGIN; default matches server dev PORT=8443
const api = process.env.DEV_API_ORIGIN || 'https://127.0.0.1:8443'
const target = { target: api, secure: false, changeOrigin: true }

export default defineConfig({
  plugins: [react()],
  base: '/run/',
  build: { outDir: 'dist', assetsDir: 'assets' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/config': target,
      '/portainer-api': target,
      '/ai': target,
      '/cache': target,
      '/env-status': target,
      '/templates': target,
    },
  },
})
