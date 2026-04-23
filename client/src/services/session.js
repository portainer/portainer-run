import { apiFetch, portainerUrlHeaders } from '../lib/api.js'
import { useAppStore } from '../store/useAppStore.js'
import { loadServerConfig } from './config.js'
import { loadDisabledEnvs } from './disabledEnvs.js'
import { cancelRefreshTimer, refreshCache } from './refreshDeployments.js'

const TOKEN_KEY = 'portainer_run_token'
const URL_KEY = 'portainer_run_url'

/**
 * @returns {Promise<boolean>}
 */
export async function connectWithToken(token) {
  const st = useAppStore.getState
  st().setConnectError('')
  if (!token?.trim()) {
    st().setConnectError('API token is required.')
    return false
  }
  if (!st().portainerFromServer) {
    const p = (st().portainerBaseUrl || '').trim()
    if (!p) {
      st().setConnectError('Portainer base URL is required (e.g. https://portainer:9443).')
      return false
    }
  }
  const tok = token.trim()
  st().setToken(tok)
  try {
    const r = await apiFetch(tok, '/endpoints')
    if (r.status === 401 || r.status === 403) {
      st().setToken('')
      st().setConnectError('Authentication failed. Check your API token.')
      return false
    }
    if (r.status === 502) {
      st().setToken('')
      st().setConnectError(
        'Proxy cannot reach that Portainer URL. Check the URL, TLS, and that the server can reach it (try portainer:9443, correct DNS, and firewall).',
      )
      return false
    }
    if (r.status === 400) {
      st().setToken('')
      const j = await r.json().catch(() => ({}))
      st().setConnectError(j?.error || r.statusText || 'Bad request')
      return false
    }
    if (!r.ok) {
      st().setToken('')
      const j = await r.json().catch(() => ({}))
      st().setConnectError(`HTTP ${r.status}. ${j?.message || r.statusText}`)
      return false
    }
    const eps = await r.json()
    const kubeEps = eps.filter((e) => [4, 5, 6, 7].includes(e.Type))
    st().setEnvironments(kubeEps.length ? kubeEps : eps)

    let isAdmin = false
    try {
      const meR = await apiFetch(tok, '/users/me')
      if (meR.ok) {
        const me = await meR.json()
        isAdmin = me.Role === 1
      }
    } catch {
      isAdmin = false
    }
    st().setIsAdmin(isAdmin)

    try {
      const cfgR = await fetch('/config')
      if (cfgR.ok) {
        const cfg = await cfgR.json()
        st().setAi(!!cfg.aiAvailable, cfg.aiProvider || 'anthropic', cfg.baseDomain || '')
      }
    } catch {
      // ignore
    }

    try {
      sessionStorage.setItem(TOKEN_KEY, tok)
      const p = (st().portainerBaseUrl || '').trim()
      if (p) sessionStorage.setItem(URL_KEY, p)
      else sessionStorage.removeItem(URL_KEY)
    } catch {
      // ignore
    }

    try {
      const cacheRes = await fetch('/cache', {
        headers: { 'X-API-Key': tok, ...portainerUrlHeaders() },
      })
      if (cacheRes.ok) {
        const cached = await cacheRes.json()
        if (cached && Array.isArray(cached.deployments) && cached.deployments.length) {
          st().setCache({
            deployments: cached.deployments,
            lastFetch: cached.lastFetch || null,
            everLoaded: true,
            fetching: false,
          })
          st().setCacheStatus('cached')
        }
      }
    } catch {
      // ignore
    }

    st().pushToast(
      `Connected — ${st().environments.length} environment(s)` + (isAdmin ? ' (admin)' : ''),
      'ok',
    )
    st().setConnected(true)
    st().closeDetail()

    await loadDisabledEnvs(tok, st().environments)
    st().setCache((c) => ({ ...c, fetching: false }))
    await refreshCache(false)
    return true
  } catch (e) {
    st().setConnectError('Network error. Proxy not responding. ' + (e && e.message))
    return false
  }
}

export function disconnect() {
  const st = useAppStore.getState
  const token = st().token
  if (token) {
    const h = { 'X-API-Key': token, ...portainerUrlHeaders() }
    fetch('/cache', { method: 'DELETE', headers: h }).catch(() => {})
  }
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // ignore
  }
  cancelRefreshTimer()
  st().reset()
  void loadServerConfig()
}

/**
 * @returns {Promise<void>}
 */
export async function tryAutoConnect() {
  const st = useAppStore.getState
  let saved
  let url
  try {
    saved = sessionStorage.getItem(TOKEN_KEY)
    url = sessionStorage.getItem(URL_KEY)
  } catch {
    return
  }
  if (!saved) return
  if (url) st().setPortainerBaseUrl(url)
  await connectWithToken(saved)
}
