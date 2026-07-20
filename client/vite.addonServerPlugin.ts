import { resolve } from 'path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Portainer Run backend route prefixes, as the server sees them (i.e. after
// the addon gateway strips the base path in production).
const BACKEND_ROUTES = ['api', 'ai', 'config', 'cache', 'env-status', 'mcp']

type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>

/**
 * Runs the Portainer Run backend inside the Vite dev server process (same
 * origin/port as the SPA), mirroring the addon gateway: backend routes under
 * the addon base are prefix-stripped and handed to the server's request
 * handler. Requires running Vite under Bun (`bun --bun vite`) for bun:sqlite.
 */
export function addonServerPlugin(base: string): Plugin {
  return {
    name: 'portainer-run-server',
    apply: 'serve',
    async configureServer(server) {
      // Imported lazily and by absolute path: the server code lives outside
      // the client package (absent from the Docker client-build stage), and
      // its config module validates the root .env at import time — both must
      // only happen when the dev server actually runs.
      const handlerPath = pathToFileURL(
        resolve(__dirname, '../server/handler.js'),
      ).href
      const { handleRequest } = (await import(handlerPath)) as {
        handleRequest: RequestHandler
      }

      const prefixes = BACKEND_ROUTES.map((route) => `${base}${route}`)

      server.middlewares.use((req, res, next) => {
        const url = req.url || '/'
        // MCP clients connect at the root path, like behind the gateway.
        const isMcp = url === '/mcp' || url.startsWith('/mcp?')
        const matched = prefixes.some((prefix) => url.startsWith(prefix))
        if (!matched && !isMcp) {
          next()
          return
        }

        if (matched) req.url = url.slice(base.length - 1)

        // Dev-only auth: inject X-API-Key from PORTAINER_API_KEY so requests
        // authenticate without the gateway session cookie. Server-side only —
        // never exposed to the browser.
        const apiKey = process.env.PORTAINER_API_KEY
        if (
          apiKey &&
          !req.headers['x-api-key'] &&
          !req.headers['authorization']
        ) {
          req.headers['x-api-key'] = apiKey
        }

        handleRequest(req, res).catch(next)
      })
    },
  }
}
