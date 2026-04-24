import { PORTAINER_URL, portainerHost, portainerPort, portainerIsHttps } from './config.js'

/**
 * Target for outbound calls to a Portainer instance.
 * @typedef {{ host: string, port: number, isHttps: boolean, key: string }} PortainerTarget
 */

/**
 * Normalized cache / env-status key (no trailing slash) for a Portainer base URL.
 * @param {import('http').IncomingMessage} req
 * @returns {null | PortainerTarget}
 */
export function resolvePortainerTarget(req) {
  const raw = (req.headers['x-portainer-url'] || req.headers['X-Portainer-URL'] || '')
    .toString()
    .trim()
  if (raw) {
    return parsePortainerBaseUrl(raw)
  }
  if (PORTAINER_URL) {
    return {
      host: portainerHost,
      port: portainerPort,
      isHttps: portainerIsHttps,
      key: stripTrailingSlash(PORTAINER_URL),
    }
  }
  return null
}

/**
 * @param {string} raw
 * @returns {null | PortainerTarget}
 */
export function parsePortainerBaseUrl(raw) {
  if (!raw) return null
  let s = String(raw).trim()
  s = s.replace(/\/$/, '')
  if (s && !/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(s)) {
    s = 'https://' + s
  }
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const isHttps = u.protocol === 'https:'
    const port = u.port
      ? parseInt(u.port, 10)
      : isHttps
        ? 443
        : 80
    return {
      host: u.hostname,
      port,
      isHttps,
      key: u.origin,
    }
  } catch {
    return null
  }
}

/**
 * @param {string} s
 */
function stripTrailingSlash(s) {
  return s.replace(/\/$/, '')
}
