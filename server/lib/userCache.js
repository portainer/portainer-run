/**
 * In-memory cache mapping Portainer API token → { userId, isAdmin, expiresAt }.
 * Avoids a /users/me call on every request while keeping identity fresh.
 */

const TTL_MS = 5 * 60 * 1000 // 5 minutes
const cache = new Map()

export function getCachedUser(token) {
  const entry = cache.get(token)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(token)
    return null
  }
  return entry
}

export function setCachedUser(token, userId, isAdmin) {
  cache.set(token, { userId, isAdmin, expiresAt: Date.now() + TTL_MS })
}
