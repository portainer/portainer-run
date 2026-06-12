import https from 'node:https'
import http from 'node:http'
import { getCachedUser, setCachedUser } from './userCache.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'

/**
 * Make a GET request directly to a Portainer instance.
 * @param {{ host, port, isHttps }} target
 * @param {string} token
 * @param {string} path
 */
export function portainerGet(target, token, path) {
  return new Promise((resolve, reject) => {
    const mod = target.isHttps ? https : http
    const req = mod.request({
      hostname: target.host,
      port: target.port,
      path,
      method: 'GET',
      headers: { 'X-API-Key': token, 'Content-Type': 'application/json' },
      rejectUnauthorized: false,
    }, (res) => {
      let body = ''
      res.on('data', (c) => body += c)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { reject(new Error('Invalid JSON from Portainer')) }
      })
    })
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

  const target = resolvePortainerTarget(req)
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
 * Extract bearer token from Authorization header or X-API-Key header.
 * @param {import('http').IncomingMessage} req
 */
export function extractToken(req) {
  const auth = req.headers['authorization'] || ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return req.headers['x-api-key'] || ''
}
