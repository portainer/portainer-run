import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import ResourceDetailHeader from '../design-system/react/ResourceDetailHeader.jsx'
import ResourceDetailTabs from '../design-system/react/ResourceDetailTabs.jsx'
import ActionBar from '../design-system/react/ActionBar.jsx'
import { icons } from '../design-system/icons.js'
import { useAppStore } from '../store/useAppStore.js'
import { serviceDetailPath } from '../lib/routes.js'
import { kubeFetch } from '../lib/api.js'
import { age } from '../lib/utils.js'
import { patchDeploymentReplicas } from '../lib/patchDeploymentReplicas.js'
import { refreshCache } from '../services/refreshDeployments.js'
import ServiceTabPanel from './serviceDetail/ServiceTabPanel.jsx'
import { fetchExposureDetail } from './serviceDetail/fetchExposureDetail.js'
import ServiceDetailLogsTab from './serviceDetail/ServiceDetailLogsTab.jsx'
import ServiceDetailMetricsTab from './serviceDetail/ServiceDetailMetricsTab.jsx'
import ServiceDetailRevisionsTab from './serviceDetail/ServiceDetailRevisionsTab.jsx'
import ServiceDetailEditTab from './serviceDetail/ServiceDetailEditTab.jsx'

/** Match old-implementation: Overview → Containers → Metrics → Logs → Revisions → Edit */
const TABS = [
  { id: 'overview', label: 'Overview', icon: icons.tabOverview },
  { id: 'containers', label: 'Containers', icon: icons.tabItems },
  { id: 'metrics', label: 'Metrics', icon: icons.monitor },
  { id: 'logs', label: 'Logs', icon: icons.logs },
  { id: 'revisions', label: 'Revisions', icon: icons.clock },
  { id: 'edit', label: 'Edit', icon: icons.edit },
]

const LEGACY_TAB_REDIRECT = {
  details: 'overview',
  events: 'overview',
  yaml: 'overview',
}

function leafTabIds(tabs) {
  const ids = []
  for (const t of tabs) {
    if (t?.dropdown && Array.isArray(t.items)) {
      for (const it of t.items) ids.push(it.id)
    } else if (t?.id) {
      ids.push(t.id)
    }
  }
  return ids
}

const VALID_TABS = new Set(leafTabIds(TABS))

function Kv({ pairs }) {
  return (
    <div className="kv">
      {pairs.map(([k, v], i) => (
        <div key={`${k}-${i}`} style={{ display: 'contents' }}>
          <div className="kv-key">{k}</div>
          <div className="kv-val" style={{ whiteSpace: 'pre-wrap' }}>
            {v == null ? '—' : String(v)}
          </div>
        </div>
      ))}
    </div>
  )
}

function formatEnvVar(e) {
  if (e.value != null) return `${e.name}=${e.value}`
  if (e.valueFrom?.fieldRef) return `${e.name}=(fieldRef)`
  if (e.valueFrom?.resourceFieldRef) return `${e.name}=(resourceFieldRef)`
  if (e.valueFrom?.configMapKeyRef) {
    const r = e.valueFrom.configMapKeyRef
    return `${e.name}=configmap(${r.name}/${r.key})`
  }
  if (e.valueFrom?.secretKeyRef) {
    const r = e.valueFrom.secretKeyRef
    return `${e.name}=secret(${r.name}/${r.key})`
  }
  return `${e.name}=*`
}

function OverviewExposure({ token, envId, namespace, name }) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState(/** @type { [string, string][] } */ ([]))
  const [emptyMessage, setEmptyMessage] = useState('')
  const [exErr, setExErr] = useState('')

  useEffect(() => {
    if (!token || !envId || !namespace || !name) return
    let cancel = false
    setLoading(true)
    setExErr('')
    void (async () => {
      const res = await fetchExposureDetail(token, envId, namespace, name)
      if (cancel) return
      setLoading(false)
      if (res.error) {
        setExErr(res.error)
        setRows([])
        setEmptyMessage('')
        return
      }
      if (res.emptyMessage) {
        setEmptyMessage(res.emptyMessage)
        setRows([])
        return
      }
      setEmptyMessage('')
      setRows(res.rows || [])
    })()
    return () => {
      cancel = true
    }
  }, [token, envId, namespace, name])

  if (loading) {
    return (
      <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Loading…</span>
    )
  }
  if (exErr) {
    return (
      <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Could not load exposure: {exErr}</span>
    )
  }
  if (emptyMessage) {
    return <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{emptyMessage}</span>
  }
  return <Kv pairs={rows} />
}

function headerStatusFromDeployment(d) {
  if (!d) {
    return { status: '', statusLabel: 'Loading…', statusColor: 'muted' }
  }
  const ready = d.status?.readyReplicas || 0
  const desired = d.spec?.replicas || 0
  const conditions = d.status?.conditions || []
  const progressing = conditions.find((c) => c.type === 'Progressing')
  if (desired === 0) {
    return { status: 'stopped', statusLabel: 'Switched off', statusColor: 'muted' }
  }
  if (ready >= desired) {
    return { status: 'running', statusLabel: 'Running', statusColor: 'success' }
  }
  if (ready > 0) {
    return { status: 'partial', statusLabel: 'Degraded', statusColor: 'warning' }
  }
  if (progressing?.status === 'True') {
    return { status: 'pending', statusLabel: 'Starting', statusColor: 'warning' }
  }
  return { status: 'error', statusLabel: 'Not available', statusColor: 'danger' }
}

export function ServiceDetailIndexRedirect() {
  const { envId, namespace, name } = useParams()
  return (
    <Navigate
      to={serviceDetailPath(envId, namespace, name, 'overview')}
      replace
    />
  )
}

export function ServiceDetailPage() {
  const { envId, namespace, name, tab: tabParam } = useParams()
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const environments = useAppStore((s) => s.environments)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const pushToast = useAppStore((s) => s.pushToast)

  const [d, setD] = useState(/** @type {object | null} */ (null))
  const [err, setErr] = useState('')
  const [restartPending, setRestartPending] = useState(false)
  const [scalePending, setScalePending] = useState(false)
  const restartInFlight = useRef(false)
  const scaleInFlight = useRef(false)

  const tab = tabParam || 'overview'

  const envName = useMemo(() => {
    const id = String(envId)
    const e = environments.find((x) => String(x.Id) === id)
    return e?.Name || id
  }, [environments, envId])

  const basePath = useMemo(
    () => serviceDetailPath(envId, namespace, name, 'overview').replace(/\/overview$/, ''),
    [envId, namespace, name],
  )

  const load = useCallback(async () => {
    if (!token || !envId || !namespace || !name) return
    setErr('')
    try {
      const r = await kubeFetch(
        token,
        envId,
        `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
      )
      if (!r.ok) {
        setD(null)
        setErr('HTTP ' + r.status)
        return
      }
      const json = await r.json()
      setD(json)
    } catch (e) {
      setD(null)
      setErr(e?.message || 'Request failed')
    }
  }, [token, envId, namespace, name])

  const runRestart = useCallback(async () => {
    if (!token || !envId || !namespace || !name || restartInFlight.current) return
    restartInFlight.current = true
    setRestartPending(true)
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
            },
          },
        },
      },
    }
    try {
      const r = await kubeFetch(
        token,
        envId,
        `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
          body: JSON.stringify(patch),
        },
      )
      if (!r.ok) {
        let message = 'HTTP ' + r.status
        try {
          const j = await r.json()
          message = j?.message || message
        } catch {
          /* ignore */
        }
        throw new Error(message)
      }
      const updated = await r.json().catch(() => null)
      if (updated) setD(updated)
      else void load()
      pushToast(`“${name}” is restarting — pods will be replaced one by one`, 'ok')
      setTimeout(() => {
        void refreshCache(false)
        void load()
      }, 2000)
    } catch (e) {
      pushToast('Restart failed: ' + (e?.message || String(e)), 'err')
    } finally {
      restartInFlight.current = false
      setRestartPending(false)
    }
  }, [token, envId, namespace, name, load, pushToast])

  const runStart = useCallback(async () => {
    if (!token || !envId || !namespace || !name || scaleInFlight.current) return
    if ((d?.spec?.replicas || 0) > 0) return
    scaleInFlight.current = true
    setScalePending(true)
    try {
      await patchDeploymentReplicas(token, String(envId), namespace, name, 1)
      pushToast(`“${name}” is starting (1 replica).`, 'ok')
      void load()
      setTimeout(() => {
        void refreshCache(false)
        void load()
      }, 2000)
    } catch (e) {
      pushToast('Start failed: ' + (e?.message || String(e)), 'err')
    } finally {
      scaleInFlight.current = false
      setScalePending(false)
    }
  }, [token, envId, namespace, name, d, load, pushToast])

  const runStop = useCallback(async () => {
    if (!token || !envId || !namespace || !name || scaleInFlight.current) return
    if ((d?.spec?.replicas || 0) === 0) return
    scaleInFlight.current = true
    setScalePending(true)
    try {
      await patchDeploymentReplicas(token, String(envId), namespace, name, 0)
      pushToast(`“${name}” is stopped (0 replicas).`, 'ok')
      void load()
      setTimeout(() => {
        void refreshCache(false)
        void load()
      }, 2000)
    } catch (e) {
      pushToast('Stop failed: ' + (e?.message || String(e)), 'err')
    } finally {
      scaleInFlight.current = false
      setScalePending(false)
    }
  }, [token, envId, namespace, name, d, load, pushToast])

  const actionBarBusy = restartPending || scalePending
  const actionBarPendingLabel = scalePending ? 'Scaling…' : 'Restarting…'

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!tabParam) return
    const legacy = LEGACY_TAB_REDIRECT[tabParam]
    if (legacy) {
      navigate(serviceDetailPath(envId, namespace, name, legacy), { replace: true })
      return
    }
    if (!VALID_TABS.has(tabParam)) {
      navigate(serviceDetailPath(envId, namespace, name, 'overview'), { replace: true })
    }
  }, [tabParam, envId, namespace, name, navigate])

  const onTabChange = useCallback(
    (id) => {
      navigate(serviceDetailPath(envId, namespace, name, id))
    },
    [navigate, envId, namespace, name],
  )

  const { status, statusLabel, statusColor } = useMemo(() => headerStatusFromDeployment(d), [d])

  const cCount = d?.spec?.template?.spec?.containers?.length || 0
  const ready = d?.status?.readyReplicas || 0
  const desired = d?.spec?.replicas || 0

  const statBlocks = useMemo(() => {
    if (!d) return []
    const dotOk = desired > 0 && ready >= desired
    return [
      {
        label: 'Replicas',
        value: String(desired === 0 ? 0 : ready),
        valueSuffix: ` / ${desired}`,
        icon: icons.stacks,
        withDot: true,
        dotStatus: dotOk ? 'synced' : 'error',
        status: dotOk ? 'synced' : 'error',
      },
      {
        label: 'Containers',
        value: String(cCount || 0),
        icon: icons.tabItems,
      },
    ]
  }, [d, cCount, desired, ready])

  const image = d?.spec?.template?.spec?.containers?.[0]?.image
  const metaItems = useMemo(
    () => [
      { text: envName, icon: icons.environments, class: '' },
      { text: `ns/${namespace}` },
    ],
    [envName, namespace],
  )

  return (
    <div className="page active service-detail-page">
      <div className="service-detail-column">
        <div className="service-detail-header-slot">
        <ResourceDetailHeader
          resourceTypeLabel="Kubernetes deployment"
          title={name || '—'}
          status={status}
          statusLabel={statusLabel}
          statusColor={statusColor || 'muted'}
          icon={icons.service}
          metaItems={metaItems}
          statBlocks={statBlocks}
          subtitleSlot={
            image ? (
              <div className="header-subtitle service-detail-image-line" title={image}>
                {image}
              </div>
            ) : null
          }
          actionBar={
            <ActionBar
              bulkActionPending={actionBarBusy}
              bulkActionLabel={actionBarPendingLabel}
              summary={
                <div
                  className="service-detail-header-actions"
                  style={{ flexWrap: 'wrap', rowGap: 6, columnGap: 8, alignItems: 'center' }}
                >
                  <button
                    type="button"
                    className="action-bar-btn"
                    title="Rolling restart — pods are replaced one by one"
                    onClick={() => void runRestart()}
                    disabled={!d || actionBarBusy}
                  >
                    <span
                      className="action-bar-btn-icon"
                      dangerouslySetInnerHTML={{ __html: icons.refresh }}
                    />
                    <span className="action-bar-btn-label">Restart</span>
                  </button>
                  <button
                    type="button"
                    className="action-bar-btn"
                    title="Set replicas to 1 (when scaled to zero)"
                    onClick={() => void runStart()}
                    disabled={!d || actionBarBusy || (desired > 0)}
                  >
                    <span
                      className="action-bar-btn-icon"
                      dangerouslySetInnerHTML={{ __html: icons.play }}
                    />
                    <span className="action-bar-btn-label">Start</span>
                  </button>
                  <button
                    type="button"
                    className="action-bar-btn"
                    title="Scale to zero replicas (workloads off)"
                    onClick={() => void runStop()}
                    disabled={!d || actionBarBusy || desired === 0}
                  >
                    <span
                      className="action-bar-btn-icon"
                      dangerouslySetInnerHTML={{ __html: icons.pause }}
                    />
                    <span className="action-bar-btn-label">Stop</span>
                  </button>
                </div>
              }
              right={
                actionBarBusy ? null : (
                  <button
                    type="button"
                    className="action-bar-btn action-bar-btn-danger"
                    onClick={() =>
                      setDeleteTarget({
                        envId: String(envId),
                        ns: namespace,
                        name,
                      })
                    }
                  >
                    <span
                      className="action-bar-btn-icon"
                      dangerouslySetInnerHTML={{ __html: icons.trash }}
                    />
                    <span className="action-bar-btn-label">Delete</span>
                  </button>
                )
              }
            />
          }
        />
        </div>

        <div className="service-detail-tabs-panel">
          <ResourceDetailTabs
            tabs={TABS}
            activeTab={tab}
            onTabChange={onTabChange}
            tabBasePath={basePath}
          />
        </div>

        <div className="service-detail-body rde-content">
          {err && !d ? (
            <p style={{ color: 'var(--red)' }} role="alert">
              {err}
            </p>
          ) : null}

          {tab === 'overview' && d && (
            <ServiceTabPanel>
              <div className="dp-section">
                <div className="dp-section-title">Status</div>
                {(() => {
                  const r = d.status?.readyReplicas || 0
                  const des = d.spec?.replicas || 0
                  const cond = (d.status?.conditions || []).find(
                    (c) => c.type === 'Available' && c.status === 'False',
                  )
                  const statusKv = [
                    ['Ready instances', des === 0 ? 'Scaled to zero' : `${r} / ${des}`],
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
                        ['Namespace', namespace],
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
                <div className="dp-section-title">Exposure</div>
                <OverviewExposure
                  token={token}
                  envId={String(envId)}
                  namespace={namespace}
                  name={name}
                />
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
            </ServiceTabPanel>
          )}

          {tab === 'containers' && d && (
            <ServiceTabPanel>
              {(d.spec?.template?.spec?.containers || []).length === 0 ? (
                <p style={{ color: 'var(--text-dim)' }}>No containers.</p>
              ) : (
                (d.spec?.template?.spec?.containers || []).map((c, i) => {
                  const ports =
                    (c.ports || [])
                      .map((p) => `${p.containerPort}/${p.protocol || 'TCP'}`)
                      .join(', ') || '—'
                  const res = c.resources || {}
                  const envVars =
                    (c.env || []).map((e) => formatEnvVar(e)).join('\n') || '—'
                  const mounts = (c.volumeMounts || [])
                    .map((v) => v.mountPath + ' → ' + v.name)
                    .join(', ')
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
                          <div className="kv-key">Pull policy</div>
                          <div className="kv-val">{c.imagePullPolicy || 'IfNotPresent'}</div>
                          <div className="kv-key">CPU request/limit</div>
                          <div className="kv-val">
                            {res.requests?.cpu || '—'} / {res.limits?.cpu || '—'}
                          </div>
                          <div className="kv-key">Mem request/limit</div>
                          <div className="kv-val">
                            {res.requests?.memory || '—'} / {res.limits?.memory || '—'}
                          </div>
                          <div className="kv-key">Env vars</div>
                          <div className="kv-val" style={{ whiteSpace: 'pre-wrap' }}>
                            {envVars}
                          </div>
                          <div className="kv-key">Volume mounts</div>
                          <div className="kv-val">{mounts || '—'}</div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </ServiceTabPanel>
          )}

          {tab === 'metrics' && d && (
            <ServiceTabPanel>
              <ServiceDetailMetricsTab
                d={d}
                envId={String(envId)}
                namespace={namespace}
                name={name}
              />
            </ServiceTabPanel>
          )}

          {tab === 'logs' && d && (
            <ServiceTabPanel>
              <ServiceDetailLogsTab envId={String(envId)} namespace={namespace} name={name} />
            </ServiceTabPanel>
          )}

          {tab === 'revisions' && d && (
            <ServiceTabPanel>
              <ServiceDetailRevisionsTab
                envId={String(envId)}
                namespace={namespace}
                name={name}
                onAfterRollback={load}
              />
            </ServiceTabPanel>
          )}

          {tab === 'edit' && d && (
            <ServiceTabPanel>
              <ServiceDetailEditTab
                d={d}
                envId={String(envId)}
                namespace={namespace}
                name={name}
                onSaved={load}
              />
            </ServiceTabPanel>
          )}
        </div>
      </div>
    </div>
  )
}
