import type { ServerResponse } from 'node:http'
import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

import { addonServerPlugin } from './vite.addonServerPlugin'

// Served as a Portainer addon behind the gateway at this base path. The gateway
// strips the prefix before forwarding to us; the build bakes it into asset URLs
// and the router basename so the browser requests everything under the prefix.
const BASE = process.env.ADDON_BASE_PATH || '/addons/portainer-run/'

export default defineConfig(({ mode }) => {
  // Root .env holds the server config (PORTAINER_URL, etc.); reuse it here so
  // dev needs a single env file.
  const env = { ...loadEnv(mode, resolve(__dirname, '..'), ''), ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value
  }

  // In prod the browser reaches Portainer same-origin at /api. In dev, proxy
  // /api to the Portainer instance and inject X-API-Key from PORTAINER_API_KEY
  // (server-side only — never exposed to the browser).
  const portainerUrl = env.PORTAINER_URL || 'https://localhost:9443'
  const portainerApiKey = env.PORTAINER_API_KEY

  return {
    base: BASE,
    // The Portainer-Run backend runs in-process (same port as the SPA);
    // no separate server process or proxy needed in dev.
    plugins: [react(), tailwindcss(), addonServerPlugin(BASE)],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@ds': resolve(__dirname, 'design-system/src'),
        // Runtime catalogue shared with the server and the MCP path, so all
        // three deploy a given runtime identically (see shared/runtimes.js).
        '@shared': resolve(__dirname, '../shared'),
      },
      // The design system source lives outside the project root; force every
      // import of react/react-dom to the single copy in our node_modules so
      // hooks never see a second React instance.
      dedupe: ['react', 'react-dom'],
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
        '/api': {
          target: portainerUrl,
          secure: false,
          changeOrigin: true,
          configure: (proxy) => {
            // Vite's built-in proxy error handler writes a bare 502 with no
            // cache directives. Chrome's in-memory cache then replays that 502
            // on a normal reload (only a hard reload clears it), so a transient
            // upstream blip right after a dev-server restart wedges the app.
            // Handle the error first (this runs before Vite's handler) and send
            // no-store so the error is never cached. Runs only for HTTP
            // responses; WebSocket upgrade errors (a raw socket) fall through.
            proxy.on('error', (err, _req, res) => {
              const httpRes = res as ServerResponse
              if (
                typeof httpRes.writeHead !== 'function' ||
                httpRes.headersSent ||
                httpRes.writableEnded
              ) {
                return
              }
              httpRes.writeHead(502, {
                'Content-Type': 'application/json',
                'Cache-Control':
                  'no-store, no-cache, must-revalidate, max-age=0',
                Pragma: 'no-cache',
                Expires: '0',
              })
              httpRes.end(
                JSON.stringify({
                  error: 'bad_gateway',
                  message: `Portainer API upstream unavailable: ${err.message}`,
                }),
              )
            })
            proxy.on('proxyReq', (proxyReq, req) => {
              if (portainerApiKey && !req.headers['x-api-key']) {
                proxyReq.setHeader('X-API-Key', portainerApiKey)
              }
              // Strip the browser's cache validators so Portainer can never
              // answer 304 Not Modified — every request gets a fresh 200.
              proxyReq.removeHeader('if-none-match')
              proxyReq.removeHeader('if-modified-since')
            })
            proxy.on('proxyRes', (proxyRes) => {
              // Drop every upstream caching signal and force no-store, so the
              // browser never serves a stale Portainer response in dev. This is
              // dev-only; in prod the real addon gateway sits in front instead.
              delete proxyRes.headers['etag']
              delete proxyRes.headers['last-modified']
              delete proxyRes.headers['expires']
              delete proxyRes.headers['vary']
              proxyRes.headers['cache-control'] =
                'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
              proxyRes.headers['pragma'] = 'no-cache'
              proxyRes.headers['expires'] = '0'
            })
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
    },
  }
})
