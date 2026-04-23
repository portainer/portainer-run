import { useMemo } from 'react'
import StatusSummaryBar from '../design-system/react/StatusSummaryBar.jsx'
import { useAppStore, visibleEnvironments } from '../store/useAppStore.js'
import { manualRefresh } from '../services/refreshDeployments.js'

function cacheDotClass(status) {
  if (status === 'loading') return 'cache-dot loading'
  if (status === 'cached') return 'cache-dot stale'
  if (status === 'fresh') return 'cache-dot fresh'
  return 'cache-dot stale'
}

function cacheLabel(cache, cacheStatus) {
  if (cacheStatus === 'loading') return 'Refreshing data…'
  if (cacheStatus === 'cached') return 'Showing last known state — live data loading…'
  if (cacheStatus === 'fresh') return 'Updated just now — auto-refreshes every 30s'
  const mins = cache.lastFetch ? Math.round((Date.now() - cache.lastFetch) / 60000) : '?'
  return `Last updated ${mins} min ago`
}

export function DashboardPage() {
  const cache = useAppStore((s) => s.cache)
  const cacheStatus = useAppStore((s) => s.cacheStatus)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const isAdmin = useAppStore((s) => s.isAdmin)

  const vis = useMemo(
    () => visibleEnvironments({ environments, disabledEnvs }),
    [environments, disabledEnvs],
  )

  const summary = useMemo(() => {
    const deps = cache.deployments
    let total = deps.length
    let running = 0
    let degraded = 0
    let unavailable = 0
    for (const d of deps) {
      const ready = d.status?.readyReplicas || 0
      const desired = d.spec?.replicas || 0
      if (desired === 0) continue
      if (ready >= desired) running++
      else if (ready > 0) degraded++
      else unavailable++
    }
    return { total, running, degraded, unavailable }
  }, [cache.deployments])

  const byEnv = useMemo(() => {
    const m = {}
    for (const e of vis) {
      m[e.Id] = { name: e.Name, total: 0, running: 0, degraded: 0, unavailable: 0, scaledDown: 0 }
    }
    for (const d of cache.deployments) {
      const env = m[d._envId]
      if (!env) continue
      env.total++
      const ready = d.status?.readyReplicas || 0
      const desired = d.spec?.replicas || 0
      if (desired === 0) env.scaledDown++
      else if (ready >= desired) env.running++
      else if (ready > 0) env.degraded++
      else env.unavailable++
    }
    return Object.values(m)
  }, [cache.deployments, vis])

  const hiddenCount = environments.length - vis.length

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-sub">Overview of all environments and workload health</div>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void manualRefresh()}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Refresh
        </button>
      </div>
      <div className="cache-bar">
        <div className={cacheDotClass(cacheStatus)} />
        <span>{cacheLabel(cache, cacheStatus)}</span>
      </div>
      {hiddenCount > 0 && !isAdmin ? (
        <div
          id="envNotice"
          style={{
            display: 'block',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--text-dim)',
            marginBottom: 16,
            padding: '10px 14px',
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          Some environments are not shown. If you expected to see more, contact your administrator.
        </div>
      ) : null}

      <div style={{ marginBottom: 24 }}>
        <StatusSummaryBar
          ambientOnly
          segments={[
            { id: 't', type: 'total', value: String(summary.total), label: 'Total services' },
            {
              id: 'r',
              type: 'status-healthy',
              value: String(summary.running),
              label: 'Running',
              showDivider: true,
            },
            {
              id: 'd',
              type: 'status-syncing',
              value: String(summary.degraded),
              label: 'Degraded',
              showDivider: true,
            },
            {
              id: 'u',
              type: 'status-error',
              value: String(summary.unavailable),
              label: 'Unavailable',
              showDivider: true,
            },
          ]}
        />
      </div>

      <div className="dp-section-title" style={{ marginBottom: 14 }}>
        Health by environment
      </div>
      <div className="env-health-grid">
        {!cache.deployments.length && cache.fetching && !cache.everLoaded
          ? vis.map((e) => (
              <div key={e.Id} className="env-health-row" style={{ opacity: 0.7 }}>
                <div className="env-health-name">{e.Name}</div>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="env-health-stat">
                    <div className="env-health-stat-val">—</div>
                    <div className="env-health-stat-lbl">
                      {['Total', 'Running', 'Degraded', 'Down'][i - 1]}
                    </div>
                  </div>
                ))}
              </div>
            ))
          : byEnv.map((env) => (
              <div key={env.name} className="env-health-row">
                <div className="env-health-name">{env.name}</div>
                <div className="env-health-stat">
                  <div className="env-health-stat-val">{env.total}</div>
                  <div className="env-health-stat-lbl">Total</div>
                </div>
                <div className="env-health-stat">
                  <div className="env-health-stat-val" style={{ color: 'var(--green)' }}>
                    {env.running}
                  </div>
                  <div className="env-health-stat-lbl">Running</div>
                </div>
                <div className="env-health-stat">
                  <div className="env-health-stat-val" style={{ color: 'var(--amber)' }}>
                    {env.degraded}
                  </div>
                  <div className="env-health-stat-lbl">Degraded</div>
                </div>
                <div className="env-health-stat">
                  <div className="env-health-stat-val" style={{ color: 'var(--red)' }}>
                    {env.unavailable}
                  </div>
                  <div className="env-health-stat-lbl">Down</div>
                </div>
              </div>
            ))}
      </div>
    </div>
  )
}
