import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// scripts/dev.mjs sets DEV_API_ORIGIN; default matches server dev PORT=8443
const api = process.env.DEV_API_ORIGIN || 'https://127.0.0.1:8443'
const target = { target: api, secure: false, changeOrigin: true }

// Served as a Portainer addon behind the gateway at this base path. The gateway
// strips the prefix before forwarding to us; the build bakes it into asset URLs
// and the router basename so the browser requests everything under the prefix.
const BASE = process.env.ADDON_BASE_PATH || '/addons/portainer-run/'

export default defineConfig({
  base: BASE,
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Portainer's own API (cookie-authenticated, same-origin in prod).
      '/api': target,
      // Portainer Run backend endpoints, reached under the addon base prefix.
      // The gateway strips the prefix in prod; in dev we strip it here so the
      // server sees the unprefixed paths it routes on (/config, /api/vibe, ...).
      [BASE]: { ...target, rewrite: (p) => p.replace(BASE.replace(/\/$/, ''), '') },
    },
  },
})
