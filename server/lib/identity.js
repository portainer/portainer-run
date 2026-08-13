import { getCachedUser, setCachedUser } from './userCache.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'
import { portainerHttpRequest } from './portainer-tls.js'

/**
 * Build the outbound auth header for a call to Portainer, matching the token
 * type: API access tokens ("ptr_" prefix) go on X-API-Key, session JWTs and
 * this add-on's machine token ("paddon_") on Authorization: Bearer, which is
 * the only header the machine API reads. Only the matching header is sent —
 * Portainer's apiKeyLookup runs first and 401s if X-API-Key holds a JWT. A JWT
 * must never be sent as the portainer_api_key cookie: core's CSRF check fails closed on
 * unsafe cookie-authenticated requests lacking Origin/Sec-Fetch-Site (which
 * server-to-server calls never send), but exempts token auth.
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
    // Answers "is the caller an administrator?", so a forged reply grants it.
    const req = portainerHttpRequest(
      target,
      {
        path,
        method: 'GET',
        headers: {
          ...portainerAuthHeaders(token),
          'Content-Type': 'application/json',
        },
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
 * Extract the Portainer token from the inbound request.
 * The addon gateway is authoritative for the credential: it stamps the session
 * JWT as Authorization: Bearer and passes an API client's X-API-Key through, so
 * those are the primary auth path. The portainer_api_key cookie is the fallback
 * for local dev (no gateway) and older gateways that forward only the cookie.
 * @param {import('http').IncomingMessage} req
 */
export function extractToken(req) {
  const auth = req.headers['authorization'] || ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()

  const apiKey = req.headers['x-api-key']
  if (apiKey) return apiKey

  const cookieHeader = req.headers['cookie'] || ''
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k.trim() === 'portainer_api_key') return v.join('=').trim()
  }
  return ''
}
