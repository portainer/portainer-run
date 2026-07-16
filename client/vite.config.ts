import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// scripts/dev.mjs sets DEV_API_ORIGIN; default matches server dev PORT=8443
const api = process.env.DEV_API_ORIGIN || 'https://127.0.0.1:8443'
const target = { target: api, secure: false, changeOrigin: true }

// Served as a Portainer addon behind the gateway at this base path. The gateway
// strips the prefix before forwarding to us; the build bakes it into asset URLs
// and the router basename so the browser requests everything under the prefix.
const BASE = process.env.ADDON_BASE_PATH || '/addons/portainer-run/'

export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@ds': resolve(__dirname, 'design-system/src'),
    },
  },
  build: { outDir: 'dist', assetsDir: 'assets' },
  server: {
    port: 5173,
    strictPort: true,
    // The design system ships TypeScript source directly; allow Vite to
    // transform it even though it lives outside the project root.
    fs: {
      allow: ['..'],
    },
    proxy: {
      // Portainer's own API (cookie-authenticated, same-origin in prod).
      '/api': target,
      // Portainer Run backend endpoints, reached under the addon base prefix.
      [BASE]: target,
    },
  },
  test: {
    environment: 'jsdom',
  },
})
