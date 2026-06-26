import { fetchEnvDeployments } from '../lib/deployments.js'
import { useAppStore, visibleEnvironments } from '../store/useAppStore.js'

const TS_KEY = 'portainer_run_ts'

function touchSession() {
  try { localStorage.setItem(TS_KEY, String(Date.now())) } catch { /* ignore */ }
}

let refreshTimer = null

export function scheduleNextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    void refreshCache(false)
  }, 30 * 1000)
}

export function cancelRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

/**
 * @param {boolean} manual
 */
export async function refreshCache(manual = false) {
  const st = useAppStore.getState
  const g = st()
  const { token, cache, setCacheStatus, setCache, isAdmin } = g
  if (!token) return
  if (cache.fetching && !manual) return

  setCache((c) => ({ ...c, fetching: true }))
  setCacheStatus('loading')

  const state = st()
  const envs = visibleEnvironments(state)
  if (!envs.length) {
    st().setCache((c) => ({ ...c, lastFetch: Date.now(), everLoaded: true, fetching: false }))
    setCacheStatus('fresh')
    touchSession()


    if (!manual) scheduleNextRefresh()
    return
  }

  try {
    await Promise.all(
      envs.map(async (env) => {
        const deps = await fetchEnvDeployments(token, env, isAdmin)
        st().setCache((prev) => {
          const next = [...prev.deployments.filter((d) => d._envId !== env.Id), ...deps]
          // Do not set fetching:true here — it is already true and will be cleared in finally
          return { ...prev, everLoaded: true, deployments: next }
        })
      }),
    )
    st().setCache((c) => ({ ...c, lastFetch: Date.now(), everLoaded: true, fetching: false }))
    setCacheStatus('fresh')
    touchSession()


  } catch (e) {
    if (manual) st().pushToast('Refresh failed: ' + (e && e.message), 'err')
    setCacheStatus('stale')
  } finally {
    // Always clear fetching and always reschedule — even on error — so the loop never dies
    st().setCache((c) => ({ ...c, fetching: false }))
    if (!manual) scheduleNextRefresh()
  }
}

export async function manualRefresh() {
  const st = useAppStore.getState
  st().setCache((c) => ({ ...c, fetching: false }))
  await refreshCache(true)
}

/**
 * After a GitOps deploy, Portainer needs time to pull and apply the manifest.
 * This fires a series of rapid follow-up refreshes to catch the Deployment
 * as soon as it appears, rather than waiting for the standard 30s cycle.
 * Refreshes at 5s, 15s, 30s, 60s after call.
 */
export function schedulePostDeployRefreshes() {
  const delays = [5000, 15000, 30000, 60000]
  for (const delay of delays) {
    setTimeout(() => {
      // Only refresh if still connected
      if (useAppStore.getState().token) {
        void refreshCache(false)
      }
    }, delay)
  }
}
