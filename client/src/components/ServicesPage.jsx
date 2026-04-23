import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore.js'
import { ROUTES } from '../lib/routes.js'
import { useEnvStatusOnDeployments, getExtraForApp } from '../hooks/useEnvStatus.js'
import { age } from '../lib/utils.js'
import { manualRefresh } from '../services/refreshDeployments.js'

function rowClasses(d) {
  const ready = d.status?.readyReplicas || 0
  const desired = d.spec?.replicas || 0
  const conditions = d.status?.conditions || []
  const progressing = conditions.find((c) => c.type === 'Progressing')
  if (desired === 0) return { border: 'svc-row-off', dot: 'status-dot-off', label: 'Switched off' }
  if (ready >= desired) return { border: 'svc-row-run', dot: 'status-dot-run', label: 'Running' }
  if (ready > 0) return { border: 'svc-row-pend', dot: 'status-dot-pend', label: 'Partially up' }
  if (progressing?.status === 'True')
    return { border: 'svc-row-pend', dot: 'status-dot-pend', label: 'Starting up' }
  return { border: 'svc-row-fail', dot: 'status-dot-fail', label: 'Not running' }
}

export function ServicesPage() {
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const cache = useAppStore((s) => s.cache)
  const envStatusClientCache = useAppStore((s) => s.envStatusClientCache)
  const openDetail = useAppStore((s) => s.openDetail)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)

  const deps = cache.deployments
  useEnvStatusOnDeployments(deps, token)

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Services</div>
          <div className="page-sub">Kubernetes deployments managed via Portainer</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void manualRefresh()}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => navigate(ROUTES.deploy)}
          >
            + Deploy
          </button>
        </div>
      </div>
      <div id="servicesContainer">
        {!deps.length ? (
          <div className="empty">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
            <h3>No deployments found</h3>
            <p>Deploy a service to get started.</p>
          </div>
        ) : (
          <div className="svc-grid">
            <div className="svc-grid-head">
              <span>Name</span>
              <span>Image</span>
              <span>Environment</span>
              <span>Status</span>
              <span>Exposure</span>
              <span>Age</span>
              <span />
            </div>
            {deps.map((d) => {
              const name = d.metadata.name
              const ns = d.metadata.namespace
              const envId = d._envId
              const envName = d._envName || '—'
              const image = d.spec?.template?.spec?.containers?.[0]?.image || '—'
              const created = d.metadata?.creationTimestamp
              const { border, dot, label } = rowClasses(d)
              const cCount = d.spec?.template?.spec?.containers?.length || 1
              const extra = getExtraForApp(envStatusClientCache, envId, name)
              return (
                <div
                  key={`${envId}-${ns}-${name}`}
                  role="button"
                  tabIndex={0}
                  className={`svc-row ${border}`}
                  data-svc-env={String(envId)}
                  data-svc-name={name}
                  onClick={() => openDetail(String(envId), ns, name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openDetail(String(envId), ns, name)
                    }
                  }}
                >
                  <div className="svc-name">
                    {name}
                    {cCount > 1 ? (
                      <span
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 10,
                          color: 'var(--accent)',
                          marginLeft: 6,
                          background: 'var(--accent-glow)',
                          padding: '1px 6px',
                          borderRadius: 8,
                        }}
                      >
                        {cCount} containers
                      </span>
                    ) : null}
                  </div>
                  <div className="svc-image" title={image}>
                    {image}
                  </div>
                  <div className="svc-ns">
                    <span className="ns-badge">{envName}</span>
                  </div>
                  <div className="status-cell">
                    <span className="status-light">
                      <span className={`status-dot ${dot}`} />
                      {label}
                    </span>
                    {extra.reason ? <span className="status-reason">{extra.reason}</span> : null}
                  </div>
                  <div className="svc-exposure svc-exposure-cell">
                    {extra.accessUrl ? (
                      <a
                        href={extra.accessUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-open"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {extra.accessLabel || extra.accessUrl}
                      </a>
                    ) : extra.accessLabel ? (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)' }}>
                        {extra.accessLabel}
                      </span>
                    ) : (
                      <span className="exp-none">—</span>
                    )}
                  </div>
                  <div className="svc-age">{age(created)}</div>
                  <div className="svc-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => openDetail(String(envId), ns, name, 'logs')}
                    >
                      Logs
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-xs"
                      onClick={() => setDeleteTarget({ envId: String(envId), ns, name })}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
