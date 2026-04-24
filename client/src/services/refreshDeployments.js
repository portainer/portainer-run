import { fetchEnvDeployments } from '../lib/deployments.js'
import { useAppStore, visibleEnvironments } from '../store/useAppStore.js'

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
  const { token, cache, setCacheStatus, setCache } = g
  if (!token) return
  if (cache.fetching && !manual) return

  setCache((c) => ({ ...c, fetching: true }))
  setCacheStatus('loading')
  if (!manual) {
    if (refreshTimer) clearTimeout(refreshTimer)
    scheduleNextRefresh()
  }

  const state = st()
  const envs = visibleEnvironments(state)
  if (!envs.length) {
    st().setCache((c) => ({ ...c, lastFetch: Date.now(), everLoaded: true, fetching: false }))
    setCacheStatus('fresh')
    return
  }

  try {
    await Promise.all(
      envs.map(async (env) => {
        const deps = await fetchEnvDeployments(token, env)
        st().setCache((prev) => {
          const next = [...prev.deployments.filter((d) => d._envId !== env.Id), ...deps]
          return { ...prev, everLoaded: true, fetching: true, deployments: next }
        })
      }),
    )
    st().setCache((c) => ({ ...c, lastFetch: Date.now(), everLoaded: true, fetching: false }))
    setCacheStatus('fresh')
  } catch (e) {
    if (manual) st().pushToast('Refresh failed: ' + (e && e.message), 'err')
    setCacheStatus('stale')
  } finally {
    st().setCache((c) => ({ ...c, fetching: false }))
  }
}

export async function manualRefresh() {
  const st = useAppStore.getState
  st().setCache((c) => ({ ...c, fetching: false }))
  await refreshCache(true)
}
