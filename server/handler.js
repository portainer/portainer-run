import url from 'node:url'
import { readBody } from './lib/http.js'
import { CORS } from './lib/cors.js'
import {
  ANTHROPIC_KEY,
  AI_PROVIDER,
  BASE_DOMAIN,
  NS_DENYLIST,
  OPENAI_KEY,
  PORTAINER_URL,
} from './config.js'
import { handleCache } from './cache.js'
import { handleEnvStatus } from './env-status.js'
import { handleTemplates } from './templates.js'
import { tryServeStatic } from './static.js'
import { proxyToPortainer } from './proxy/portainer.js'
import { proxyToAnthropic } from './proxy/anthropic.js'
import { proxyToOpenAI } from './proxy/openai.js'
import { handleConnections } from './routes/connections.js'
import { handleGitOps } from './routes/gitops.js'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease', 'portainer', ...NS_DENYLIST])

function extractNamespace(path) {
  const m = path.match(/\/namespaces\/([^/]+)/)
  return m ? m[1] : null
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function handleRequest(req, res) {
  const parsed = url.parse(req.url)
  const pathname = parsed.pathname || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
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
        nsDenylist: [...SYSTEM_NS],
      }),
    )
    return
  }

  if (pathname === '/templates') {
    handleTemplates(req, res)
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

  if (pathname.startsWith('/portainer-api/')) {
    const body = await readBody(req)
    const upstreamPath =
      '/api/' + pathname.slice('/portainer-api/'.length) + (parsed.search || '')
    if (MUTATING_METHODS.has(req.method)) {
      const ns = extractNamespace(upstreamPath)
      if (ns && (ns.startsWith('kube-') || SYSTEM_NS.has(ns))) {
        res.writeHead(403, { 'Content-Type': 'application/json', ...CORS })
        res.end(JSON.stringify({ error: `Namespace "${ns}" is a system namespace and cannot be modified through Portainer Run.` }))
        return
      }
    }
    proxyToPortainer(req, res, upstreamPath, body)
    return
  }

  if (pathname === '/ai/triage') {
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

  // GitOps deploy/update API
  if (pathname.startsWith('/api/gitops')) {
    const handled = await handleGitOps(req, res, pathname)
    if (handled !== null) return
  }

  if (tryServeStatic(pathname, res)) return

  if (!res.headersSent) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  }
}
