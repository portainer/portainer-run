import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore.js'
import { kubeFetch } from '../lib/api.js'
import { age } from '../lib/utils.js'
import ResourceDetailTabs from '../design-system/react/ResourceDetailTabs.jsx'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'containers', label: 'Containers' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'logs', label: 'Logs' },
  { id: 'revisions', label: 'Revisions' },
  { id: 'edit', label: 'Edit' },
]

function Kv({ pairs }) {
  return (
    <div className="kv">
      {pairs.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <div className="kv-key">{k}</div>
          <div className="kv-val" style={{ whiteSpace: 'pre-wrap' }}>
            {v == null ? '—' : String(v)}
          </div>
        </div>
      ))}
    </div>
  )
}

export function DetailPanel() {
  const token = useAppStore((s) => s.token)
  const detail = useAppStore((s) => s.detail)
  const closeDetail = useAppStore((s) => s.closeDetail)
  const setDetailDeployment = useAppStore((s) => s.setDetailDeployment)
  const [tab, setTab] = useState('overview')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (detail) setTab(detail.initialTab || 'overview')
  }, [detail])

  useEffect(() => {
    if (!detail) return
    setErr('')
    let cancelled = false
    const { envId, ns, name } = detail
    ;(async () => {
      try {
        const r = await kubeFetch(token, envId, `/apis/apps/v1/namespaces/${ns}/deployments/${name}`)
        if (cancelled) return
        if (!r.ok) {
          setErr('HTTP ' + r.status)
          return
        }
        const d = await r.json()
        setDetailDeployment(d)
      } catch (e) {
        if (!cancelled) setErr(e?.message || 'Request failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [detail, token, setDetailDeployment])

  if (!detail) return null
  const d = detail.deployment
  const { envId, ns, name } = detail

  return (
    <>
      <div className="overlay-bg open" role="presentation" onClick={() => closeDetail()} />
      <div className="detail-panel open">
        <div className="dp-head">
          <h2>{name}</h2>
          {d ? (
            <span className="ns-badge" style={{ fontSize: 12 }}>
              {d.metadata?.namespace}
            </span>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => closeDetail()}>
            ✕
          </button>
        </div>
        <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <ResourceDetailTabs tabs={TABS} activeTab={tab} onTabChange={setTab} />
        </div>
        <div className="dp-body">
          {err && !d ? <p style={{ color: 'var(--red)' }}>{err}</p> : null}
          {tab === 'overview' && d && (
            <>
              <div className="dp-section">
                <div className="dp-section-title">Status</div>
                {(() => {
                  const ready = d.status?.readyReplicas || 0
                  const desired = d.spec?.replicas || 0
                  const cond = (d.status?.conditions || []).find(
                    (c) => c.type === 'Available' && c.status === 'False',
                  )
                  const statusKv = [
                    ['Ready instances', desired === 0 ? 'Scaled to zero' : `${ready} / ${desired}`],
                    ['Updated instances', d.status?.updatedReplicas || 0],
                    ['Available instances', d.status?.availableReplicas || 0],
                    ['Observed generation', d.status?.observedGeneration || 0],
                  ]
                  if (cond) statusKv.push(['Failure reason', cond.message || '—'])
                  return <Kv pairs={statusKv} />
                })()}
              </div>
              <div className="dp-section">
                <div className="dp-section-title">Configuration</div>
                {(() => {
                  const spec = d.spec
                  return (
                    <Kv
                      pairs={[
                        ['Namespace', ns],
                        ['Instances', d.spec?.replicas],
                        ['Strategy', spec?.strategy?.type || '—'],
                        [
                          'Max surge',
                          spec?.strategy?.rollingUpdate?.maxSurge != null
                            ? String(spec.strategy.rollingUpdate.maxSurge)
                            : '—',
                        ],
                        [
                          'Max unavailable',
                          spec?.strategy?.rollingUpdate?.maxUnavailable != null
                            ? String(spec.strategy.rollingUpdate.maxUnavailable)
                            : '—',
                        ],
                        ['Created', new Date(d.metadata.creationTimestamp).toLocaleString()],
                        ['Age', age(d.metadata.creationTimestamp)],
                      ]}
                    />
                  )
                })()}
              </div>
              <div className="dp-section">
                <div className="dp-section-title">Labels</div>
                <Kv
                  pairs={
                    Object.keys(d.metadata?.labels || {}).length
                      ? Object.entries(d.metadata.labels)
                      : [['(none)', '—']]
                  }
                />
              </div>
            </>
          )}

          {tab === 'containers' && d && (
            <div>
              {(d.spec?.template?.spec?.containers || []).map((c, i) => {
                const ports = (c.ports || [])
                  .map((p) => `${p.containerPort}/${p.protocol || 'TCP'}`)
                  .join(', ') || '—'
                return (
                  <div key={c.name || i} className="container-card" style={{ marginBottom: 12 }}>
                    <div className="container-card-head">
                      <span className="cname">{c.name}</span>
                      {i === 0 ? (
                        <span className="cprimary">primary</span>
                      ) : (
                        <span
                          style={{
                            fontFamily: 'var(--mono)',
                            fontSize: 10,
                            color: 'var(--text-dim)',
                          }}
                        >
                          sidecar
                        </span>
                      )}
                    </div>
                    <div className="container-card-body">
                      <div className="kv" style={{ rowGap: 8 }}>
                        <div className="kv-key">Image</div>
                        <div className="kv-val">{c.image}</div>
                        <div className="kv-key">Ports</div>
                        <div className="kv-val">{ports}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {['metrics', 'logs', 'revisions', 'edit'].includes(tab) && (
            <p className="hint" style={{ color: 'var(--text-dim)' }}>
              The <strong>{tab}</strong> tab is not fully wired in this build yet. Close the panel and
              use refresh from the list, or extend this view.
            </p>
          )}
        </div>
      </div>
    </>
  )
}
