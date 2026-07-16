import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import type { HttpProxy, ProxyOptions } from 'vite'

// Served as a Portainer addon behind the gateway at this base path. The gateway
// strips the prefix before forwarding to us; the build bakes it into asset URLs
// and the router basename so the browser requests everything under the prefix.
const BASE = process.env.ADDON_BASE_PATH || '/addons/portainer-run/'

// Portainer Run backend route prefixes (as the server sees them, i.e. after
// the gateway strips the addon base). The dev proxy below mirrors the gateway:
// it matches these under BASE and strips the prefix before forwarding.
const BACKEND_ROUTES = ['api', 'ai', 'config', 'cache', 'env-status', 'mcp']

export default defineConfig(({ mode }) => {
  // Root .env holds the server config (PORTAINER_URL, etc.); reuse it here so
  // dev needs a single env file.
  const env = { ...loadEnv(mode, resolve(__dirname, '..'), ''), ...process.env }

  // scripts/dev.mjs sets DEV_API_ORIGIN; default matches server dev PORT=8443
  const api = env.DEV_API_ORIGIN || 'https://127.0.0.1:8443'

  // In prod the browser reaches Portainer same-origin at /api. In dev, proxy
  // /api to the Portainer instance and optionally inject X-API-Key from
  // PORTAINER_API_KEY (server-side only — never exposed to the browser).
  const portainerUrl = env.PORTAINER_URL || 'https://localhost:9443'
  const portainerApiKey = env.PORTAINER_API_KEY

  const injectApiKey = (proxy: HttpProxy.Server) => {
    proxy.on('proxyReq', (proxyReq, req) => {
      if (portainerApiKey && !req.headers['x-api-key']) {
        proxyReq.setHeader('X-API-Key', portainerApiKey)
      }
    })
  }

  const backendTarget: ProxyOptions = {
    target: api,
    secure: false,
    changeOrigin: true,
    configure: injectApiKey,
  }

  return {
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
        // Portainer Run backend endpoints, reached under the addon base
        // prefix. Only the backend routes are proxied (not all of BASE) so
        // Vite still serves the app's own pages and assets under BASE.
        ...Object.fromEntries(
          BACKEND_ROUTES.map((route) => [
            `${BASE}${route}`,
            {
              ...backendTarget,
              rewrite: (path: string) => path.slice(BASE.length - 1),
            },
          ]),
        ),
        // MCP clients connect to the dev server at the root path.
        '/mcp': backendTarget,
        // Portainer's own API (cookie-authenticated, same-origin in prod).
        '/api': {
          target: portainerUrl,
          secure: false,
          changeOrigin: true,
          configure: injectApiKey,
        },
      },
    },
    test: {
      environment: 'jsdom',
    },
  }
})
