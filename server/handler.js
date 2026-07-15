import url from 'node:url'
import { readBody } from './lib/http.js'
import { CORS } from './lib/cors.js'
import { isCrossSiteRequest } from './lib/csrf.js'
import {
  ANTHROPIC_KEY,
  AI_PROVIDER,
  BASE_DOMAIN,
  OPENAI_KEY,
  PORTAINER_URL,
  CONFIG_NAMESPACE,
  VERSION,
} from './config.js'
import { handleCache } from './cache.js'
import { handleEnvStatus } from './env-status.js'
import { tryServeStatic } from './static.js'
import { proxyToAnthropic } from './proxy/anthropic.js'
import { proxyToOpenAI } from './proxy/openai.js'
import { handleConnections } from './routes/connections.js'
import { handleVibe } from './routes/vibe.js'
import { handleMcp } from './routes/mcp.js'
import { resolveCallerIdentity } from './lib/identity.js'

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function handleRequest(req, res) {
  const parsed = url.parse(req.url)
  const pathname = parsed.pathname || '/'

  // Baseline security headers on every response (merged into later writeHead
  // calls by Node). Frame-blocking matters now that actions ride on an ambient
  // session cookie — it stops the addon being iframed for clickjacking.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  // CSRF: block browser-issued cross-site requests to state-changing routes.
  if (req.method !== 'GET' && req.method !== 'HEAD' && isCrossSiteRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: 'Cross-site request blocked' }))
    return
  }

  if (pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    res.end(
      JSON.stringify({
        portainerUrl: PORTAINER_URL || null,
        portainerFromServer: Boolean(PORTAINER_URL),
        aiAvailable: !!(ANTHROPIC_KEY || OPENAI_KEY),
        aiProvider: AI_PROVIDER,
        baseDomain: BASE_DOMAIN,
        configNamespace: CONFIG_NAMESPACE,
        version: VERSION,
      }),
    )
    return
  }

  if (pathname === '/cache') {
    handleCache(req, res)
    return
  }

  if (pathname.startsWith('/env-status/')) {
    const envId = pathname.slice('/env-status/'.length).split('/')[0]
    if (!envId) {
      res.writeHead(400, CORS)
      res.end()
      return
    }
    await handleEnvStatus(req, res, envId)
    return
  }

  if (pathname === '/ai/triage') {
    // Require a valid Portainer identity — this endpoint proxies to a paid LLM
    // API using the server's key, so it must not be an open proxy.
    const caller = await resolveCallerIdentity(req)
    if (!caller) {
      res.writeHead(401, { 'Content-Type': 'application/json', ...CORS })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const body = await readBody(req)
    if (!body || !body.length) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }
    if (AI_PROVIDER === 'openai') {
      proxyToOpenAI(req, res, body)
    } else {
      proxyToAnthropic(req, res, body)
    }
    return
  }

  // Git target connections API
  if (pathname.startsWith('/api/connections')) {
    const handled = await handleConnections(req, res, pathname)
    if (handled !== null) return
  }

  // Vibe deploy API
  if (pathname.startsWith('/api/vibe')) {
    const handled = await handleVibe(req, res, pathname)
    if (handled !== null) return
  }

  // MCP (Model Context Protocol) endpoint
  if (pathname === '/mcp') {
    await handleMcp(req, res)
    return
  }

  if (tryServeStatic(pathname, res)) return

  if (!res.headersSent) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  }
}
