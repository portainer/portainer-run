import https from 'node:https'
import http from 'node:http'
import { getCachedUser, setCachedUser } from './userCache.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'

/**
 * Build the auth header for an outbound request to Portainer, matching the
 * token type — mirroring Portainer's own bouncer. API access tokens (the "ptr_"
 * prefix) authenticate via X-API-Key; session JWTs via Authorization: Bearer.
 * Only the matching header is sent, never both: Portainer's apiKeyLookup runs
 * first and 401s when X-API-Key holds a non-API-key value (e.g. a JWT) instead
 * of falling through to the JWT lookup. Routing by type lets the MCP server be
 * driven by a long-lived X-API-Key while the browser keeps its JWT.
 *
 * The JWT must NOT be forwarded as the portainer_api_key cookie: Portainer's
 * CSRF middleware fails closed on unsafe cookie-authenticated requests that
 * lack Origin/Sec-Fetch-Site headers (which server-to-server requests never
 * carry), while token-authenticated requests are exempt.
 * @param {string} token
 * @returns {Record<string, string>}
 */
export function portainerAuthHeaders(token) {
  return token.startsWith('ptr_')
    ? { 'X-API-Key': token }
    : { Authorization: `Bearer ${token}` }
}

/**
 * Make a GET request directly to a Portainer instance.
 * @param {{ host, port, isHttps }} target
 * @param {string} token
 * @param {string} path
 */
export function portainerGet(target, token, path) {
  return new Promise((resolve, reject) => {
    const mod = target.isHttps ? https : http
    const req = mod.request(
      {
        hostname: target.host,
        port: target.port,
        path,
        method: 'GET',
        headers: {
          ...portainerAuthHeaders(token),
          'Content-Type': 'application/json',
        },
        rejectUnauthorized: false,
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('Invalid JSON from Portainer'))
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * Resolve caller identity from their Portainer API token.
 * Accepts token from X-API-Key header or Authorization: Bearer <token>.
 * Cached for 5 minutes to avoid hammering Portainer /users/me on every request.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ userId: string, isAdmin: boolean, token: string } | null>}
 */
export async function resolveCallerIdentity(req) {
  const token = extractToken(req)
  if (!token) return null

  const cached = getCachedUser(token)
  if (cached) return { ...cached, token }

  const target = resolvePortainerTarget()
  if (!target) return null

  try {
    const data = await portainerGet(target, token, '/api/users/me')
    if (!data?.Id) return null
    const userId = String(data.Id)
    const isAdmin = data.Role === 1
    setCachedUser(token, userId, isAdmin)
    return { userId, isAdmin, token }
  } catch {
    return null
  }
}

/**
 * Extract the Portainer JWT from the inbound request.
 * Cookie (portainer_api_key) takes priority — this is the addon-gateway auth path.
 * Falls back to Authorization: Bearer and X-API-Key for backward compatibility.
 * @param {import('http').IncomingMessage} req
 */
export function extractToken(req) {
  const cookieHeader = req.headers['cookie'] || ''
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k.trim() === 'portainer_api_key') return v.join('=').trim()
  }
  const auth = req.headers['authorization'] || ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return req.headers['x-api-key'] || ''
}
