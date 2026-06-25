import { apiFetch, serverFetch } from '../lib/api.js'
import { useAppStore, visibleDeployments } from '../store/useAppStore.js'
import { loadServerConfig } from './config.js'
import { loadDisabledEnvs } from './disabledEnvs.js'
import { cancelRefreshTimer, refreshCache } from './refreshDeployments.js'

// Truthy placeholder kept in the store so the many components that read
// `s.token` and guard on it keep working. Auth actually rides on the Portainer
// session cookie (see lib/api.js); the value itself is never sent anywhere.
const SESSION_SENTINEL = 'session'

/** Portainer EndpointType values that are Kubernetes (see Portainer api/portainer.go). */
const K8S_TYPES = [5, 6, 7]

/** Send the user to Portainer's login. The addon gateway 302s unauthenticated
 *  requests to `/`, which renders the Portainer login page. */
function redirectToLogin() {
  window.location.href = '/'
}

/**
 * Establish the session from the ambient Portainer cookie. No token entry: if
 * the cookie is missing/expired, Portainer's API returns 401 and we hand off to
 * the login page. Mirrors portal-template's approach.
 * @returns {Promise<boolean>}
 */
export async function bootstrap() {
  const st = useAppStore.getState
  st().setAuthChecking(true)

  await loadServerConfig()

  let me
  try {
    const meR = await apiFetch(null, '/users/me')
    if (meR.status === 401 || meR.status === 403) {
      redirectToLogin()
      return false
    }
    if (!meR.ok) {
      st().setConnectError(`Could not load your Portainer account (HTTP ${meR.status}).`)
      st().setAuthChecking(false)
      return false
    }
    me = await meR.json()
  } catch (e) {
    st().setConnectError('Cannot reach Portainer. ' + (e && e.message))
    st().setAuthChecking(false)
    return false
  }

  st().setToken(SESSION_SENTINEL)
  st().setIsAdmin(me.Role === 1)
  st().setUserId(String(me.Id || ''))
  st().setUsername(me.Username || me.username || '')

  try {
    const epR = await apiFetch(null, '/endpoints')
    const eps = epR.ok ? await epR.json() : []
    const kubeEps = (Array.isArray(eps) ? eps : []).filter((e) => K8S_TYPES.includes(e.Type))
    st().setEnvironments(kubeEps)
  } catch {
    st().setEnvironments([])
  }

  try {
    const cacheRes = await serverFetch('/cache')
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
    // ignore — cache is an optimization
  }

  st().setConnected(true)
  st().setAuthChecking(false)

  // Background tasks — don't block first render.
  void loadDisabledEnvs(SESSION_SENTINEL, st().environments)
    .then(() => {
      st().setCache((c) => ({ ...c, fetching: false, deployments: visibleDeployments(useAppStore.getState()) }))
      return refreshCache(false)
    })
    .catch(() => {})
  return true
}

/**
 * Log out: clear Portainer's session cookie, then hand off to the login page.
 */
export async function logout() {
  const st = useAppStore.getState
  try {
    await serverFetch('/cache', { method: 'DELETE' })
  } catch {
    // ignore
  }
  try {
    await apiFetch(null, '/auth/logout', { method: 'POST' })
  } catch {
    // ignore — still redirect; gateway will re-challenge.
  }
  cancelRefreshTimer()
  st().reset()
  redirectToLogin()
}

// Back-compat alias for existing callers (e.g. the account menu).
export const disconnect = logout
