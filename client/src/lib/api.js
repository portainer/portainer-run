import { useAppStore } from '../store/useAppStore.js'

/**
 * @returns {Record<string, string>} headers for Portainer target (proxy reads X-Portainer-URL).
 */
export function portainerUrlHeaders() {
  const { portainerBaseUrl, portainerFromServer } = useAppStore.getState()
  const u = (portainerBaseUrl || '').trim()
  if (u) return { 'X-Portainer-URL': u }
  if (portainerFromServer) return {}
  return {}
}

/** @param {string} token @param {string} path @param {RequestInit} [opts] */
export function apiFetch(token, path, opts = {}) {
  return fetch('/portainer-api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': token,
      ...portainerUrlHeaders(),
      ...(opts.headers || {}),
    },
  })
}

export function kubeFetch(token, envId, path, opts = {}) {
  return apiFetch(token, `/endpoints/${envId}/kubernetes${path}`, opts)
}
