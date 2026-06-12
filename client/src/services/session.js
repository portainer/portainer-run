import { apiFetch, portainerUrlHeaders } from '../lib/api.js'
import { useAppStore, visibleDeployments } from '../store/useAppStore.js'
import { loadServerConfig } from './config.js'
import { loadDisabledEnvs } from './disabledEnvs.js'
import { cancelRefreshTimer, refreshCache } from './refreshDeployments.js'

const TOKEN_KEY = 'portainer_run_token'
const URL_KEY = 'portainer_run_url'
const TS_KEY = 'portainer_run_ts'
const SESSION_TTL_MS = 60 * 60 * 1000 // 1 hour

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
    /**
     * Portainer `EndpointType` (see portainer `api/portainer.go`): 1=Docker, 2=Agent-on-Docker,
     * 3=Azure, 4=Edge-agent-on-Docker, 5=Kubernetes (local), 6=agent-on-Kubernetes, 7=Edge-on-Kubernetes.
     * This app is Kubernetes-only — use 5–7 only (exclude 4 = Edge Docker).
     */
    const K8S_TYPES = [5, 6, 7]
    const kubeEps = (Array.isArray(eps) ? eps : []).filter((e) => K8S_TYPES.includes(e.Type))
    st().setEnvironments(kubeEps)

    let isAdmin = false
    try {
      const meR = await apiFetch(tok, '/users/me')
      if (meR.ok) {
        const me = await meR.json()
        isAdmin = me.Role === 1
        st().setUserId(String(me.Id || ''))
        st().setUsername(me.Username || me.username || '')
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
      localStorage.setItem(TOKEN_KEY, tok)
      localStorage.setItem(TS_KEY, String(Date.now()))
      const p = (st().portainerBaseUrl || '').trim()
      if (p) localStorage.setItem(URL_KEY, p)
      else localStorage.removeItem(URL_KEY)
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

    const nK8s = st().environments.length
    const nOther = (Array.isArray(eps) ? eps.length : 0) - nK8s
    const otherHint =
      nOther > 0
        ? ` — ${nOther} non-Kubernetes endpoint(s) in Portainer are not listed (this app is Kubernetes only).`
        : ''
    st().pushToast(
      `Connected — ${nK8s} Kubernetes environment(s)${otherHint}` + (isAdmin ? ' (admin)' : ''),
      'ok',
    )
    st().setConnected(true)

    // Fire background tasks without awaiting — don't block bootstrap on cache refresh
    st().setAuthChecking(false)
    void loadDisabledEnvs(tok, st().environments).then(() => {
      st().setCache((c) => {
        const pruned = visibleDeployments(useAppStore.getState())
        return { ...c, fetching: false, deployments: pruned }
      })
      return refreshCache(false)
    }).catch(() => {})
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
    localStorage.removeItem(TOKEN_KEY)
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
    saved = localStorage.getItem(TOKEN_KEY)
    url = localStorage.getItem(URL_KEY)
  } catch {
    return
  }
  if (!saved) return

  // Check session has not expired
  let ts = 0
  try { ts = parseInt(localStorage.getItem(TS_KEY) || '0', 10) } catch { /* ignore */ }
  if (!ts || Date.now() - ts > SESSION_TTL_MS) {
    try {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(URL_KEY)
      localStorage.removeItem(TS_KEY)
    } catch { /* ignore */ }
    return
  }

  // Optimistic auth — restore session immediately from stored token so the UI
  // renders at once, then validate in the background. If validation fails,
  // disconnect and the user is redirected to the connect screen.
  if (url) st().setPortainerBaseUrl(url)
  st().setToken(saved)
  st().setConnected(true)

  // Background validation
  void connectWithToken(saved).then((ok) => {
    if (!ok) disconnect()
  })
}
