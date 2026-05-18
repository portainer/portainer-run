import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import ResourceDetailHeader from '../design-system/react/ResourceDetailHeader.jsx'
import ResourceDetailTabs from '../design-system/react/ResourceDetailTabs.jsx'
import ActionBar from '../design-system/react/ActionBar.jsx'
import { icons } from '../design-system/icons.js'
import { useAppStore, visibleEnvironments } from '../store/useAppStore.js'
import { serviceDetailPath } from '../lib/routes.js'
import { kubeFetch } from '../lib/api.js'
import { age } from '../lib/utils.js'
import { patchDeploymentReplicas } from '../lib/patchDeploymentReplicas.js'
import { restartDeployment } from '../lib/restartDeployment.js'
import { refreshCache } from '../services/refreshDeployments.js'
import { loadDeployFormFromCluster } from '../lib/deployFormLoadFromCluster.js'
import {
  buildK8sContainer,
  executeDeploy,
  fetchNamespaceOptions,
  readVolumeDefForDeploy,
} from '../lib/deployK8s.js'
import { withDefaultCnames } from '../lib/deployFormModel.js'
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

function headerStatusClass(status, statusColor) {
  if (status === 'running') return 'status-running'
  if (status === 'error') return 'status-error'
  if (status === 'partial') return 'status-partial'
  if (status === 'pending') return 'status-pending'
  if (status === 'stopped') return 'status-stopped'
  if (statusColor === 'success') return 'status-running'
  if (statusColor === 'danger') return 'status-error'
  if (statusColor === 'warning') return 'status-partial'
  if (statusColor === 'pending') return 'status-pending'
  return 'status-stopped'
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
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const pushToast = useAppStore((s) => s.pushToast)

  const [d, setD] = useState(/** @type {object | null} */ (null))
  const [err, setErr] = useState('')
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [migrateEnvId, setMigrateEnvId] = useState(String(envId || ''))
  const [migrateNamespace, setMigrateNamespace] = useState('')
  const [migrateManualNs, setMigrateManualNs] = useState(false)
  const [migrateManualNsValue, setMigrateManualNsValue] = useState(namespace || '')
  const [migrateNsList, setMigrateNsList] = useState([])
  const [migrateNsLoading, setMigrateNsLoading] = useState(false)
  const [migrateNsStatus, setMigrateNsStatus] = useState({ text: '', tone: 'dim' })
  const [migratePending, setMigratePending] = useState(false)
  const [refreshPending, setRefreshPending] = useState(false)
  const [restartPending, setRestartPending] = useState(false)
  const [scalePending, setScalePending] = useState(false)
  const loadInFlight = useRef(null)
  const refreshInFlight = useRef(false)
  const restartInFlight = useRef(false)
  const scaleInFlight = useRef(false)

  const tab = tabParam || 'overview'

  const envName = useMemo(() => {
    const id = String(envId)
    const e = environments.find((x) => String(x.Id) === id)
    return e?.Name || id
  }, [environments, envId])
  const visEnvs = useMemo(
    () => visibleEnvironments({ environments, disabledEnvs }),
    [environments, disabledEnvs],
  )

  const basePath = useMemo(
    () => serviceDetailPath(envId, namespace, name, 'overview').replace(/\/overview$/, ''),
    [envId, namespace, name],
  )

  const load = useCallback(async () => {
    if (!token || !envId || !namespace || !name) return
    if (loadInFlight.current) return loadInFlight.current
    const p = (async () => {
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
      } finally {
        loadInFlight.current = null
      }
    })()
    loadInFlight.current = p
    return p
  }, [token, envId, namespace, name])

  const runRestart = useCallback(async () => {
    if (!token || !envId || !namespace || !name || restartInFlight.current) return
    restartInFlight.current = true
    setRestartPending(true)
    try {
      const updated = await restartDeployment(token, String(envId), namespace, name)
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

  const runRefresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshPending(true)
    try {
      await refreshCache(false)
      await load()
    } finally {
      refreshInFlight.current = false
      setRefreshPending(false)
    }
  }, [load])

  const openMigrateDialog = useCallback(() => {
    setMigrateEnvId(String(envId || ''))
    setMigrateNamespace('')
    setMigrateManualNs(false)
    setMigrateManualNsValue(namespace || '')
    setMigrateNsList([])
    setMigrateNsStatus({ text: '', tone: 'dim' })
    setMigrateOpen(true)
  }, [envId, namespace])

  const loadMigrateNamespaces = useCallback(
    async (targetEnv) => {
      if (!targetEnv || !token) {
        setMigrateNsLoading(false)
        setMigrateNsList([])
        setMigrateManualNs(false)
        setMigrateNamespace('')
        setMigrateNsStatus({ text: '', tone: 'dim' })
        return
      }
      setMigrateNsLoading(true)
      setMigrateNsStatus({ text: 'Loading…', tone: 'dim' })
      try {
        const r = await fetchNamespaceOptions(token, targetEnv)
        if (r.ok && r.manual) {
          setMigrateNsList([])
          setMigrateManualNs(true)
          setMigrateNamespace('')
          setMigrateNsStatus({
            text: r.message || 'Token is namespace-scoped — enter manually.',
            tone: 'amber',
          })
        } else if (r.ok) {
          const list = r.namespaces || []
          setMigrateNsList(list)
          setMigrateManualNs(false)
          setMigrateNamespace(list[0] || '')
          setMigrateNsStatus({ text: r.message || `${list.length} namespace(s)`, tone: 'green' })
        } else {
          setMigrateNsList([])
          setMigrateManualNs(true)
          setMigrateNamespace('')
          setMigrateNsStatus({ text: r.error || 'Failed to fetch namespaces', tone: 'red' })
        }
      } catch (e) {
        setMigrateNsList([])
        setMigrateManualNs(true)
        setMigrateNamespace('')
        setMigrateNsStatus({ text: e?.message || 'Error loading namespaces', tone: 'red' })
      } finally {
        setMigrateNsLoading(false)
      }
    },
    [token],
  )

  useEffect(() => {
    if (!migrateOpen) return
    void loadMigrateNamespaces(migrateEnvId)
  }, [migrateOpen, migrateEnvId, loadMigrateNamespaces])

  const runMigrate = useCallback(async (mode) => {
    if (!token || !envId || !namespace || !name) return
    const targetEnv = String(migrateEnvId || '').trim()
    const targetNs = String(
      migrateManualNs ? migrateManualNsValue : migrateNamespace || '',
    ).trim()
    if (!targetEnv) {
      pushToast('Pick a target environment', 'err')
      return
    }
    if (!targetNs) {
      pushToast('Enter a target namespace', 'err')
      return
    }
    if (targetEnv === String(envId) && targetNs === namespace) {
      pushToast('Pick a different environment and/or namespace', 'err')
      return
    }
    setMigratePending(true)
    try {
      const loaded = await loadDeployFormFromCluster(token, String(envId), namespace, name)
      const forBuild = withDefaultCnames(loaded.containers || [])
      const pairs = forBuild
        .map((c) => {
          const spec = buildK8sContainer(c)
          return spec ? { id: c.id, spec } : null
        })
        .filter(Boolean)
      if (!pairs.length) throw new Error('No containers found to migrate')
      const volDefs = forBuild.map((c) => readVolumeDefForDeploy(c)).filter(Boolean)
      const servicePorts = (loaded.svcPorts || [])
        .map((p) => parseInt(String(p), 10))
        .filter((n) => n > 0)
      await executeDeploy(token, {
        envId: targetEnv,
        ns: targetNs,
        appName: name,
        instances: Math.max(0, Math.min(100, parseInt(String(loaded.instances), 10) || 1)),
        containerSpecs: pairs.map((p) => p.spec),
        containerRowIds: pairs.map((p) => p.id),
        volumeDefs: volDefs,
        exposeType: loaded.exposeType || 'none',
        servicePorts,
        ingress: {
          host: (loaded.ingHost || '').trim(),
          path: (loaded.ingPath || '/').trim() || '/',
          port: loaded.ingPort || 80,
          ingressClass: (loaded.ingClass || '').trim(),
        },
      })
      if (mode === 'move') {
        const del = await kubeFetch(
          token,
          String(envId),
          `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
          { method: 'DELETE' },
        )
        if (!del.ok && del.status !== 404) {
          throw new Error('Cloned successfully, but delete failed (HTTP ' + del.status + ')')
        }
      }
      setMigrateOpen(false)
      await refreshCache(false)
      pushToast(
        mode === 'move'
          ? `Moved “${name}” to ${targetNs} on ${targetEnv}`
          : `Cloned “${name}” to ${targetNs} on ${targetEnv}`,
        'ok',
      )
      if (mode === 'move') {
        navigate(serviceDetailPath(targetEnv, targetNs, name, 'overview'), { replace: true })
      }
    } catch (e) {
      pushToast((mode === 'move' ? 'Move' : 'Clone') + ' failed: ' + (e?.message || String(e)), 'err')
    } finally {
      setMigratePending(false)
    }
  }, [
    token,
    envId,
    namespace,
    name,
    migrateEnvId,
    migrateNamespace,
    migrateManualNs,
    migrateManualNsValue,
    pushToast,
    navigate,
  ])

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

  const actionBarBusy = refreshPending || restartPending || scalePending
  const actionBarPendingLabel = refreshPending
    ? 'Refreshing…'
    : scalePending
      ? 'Scaling…'
      : 'Restarting…'

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
  return (
    <div className="page active service-detail-page">
      <div className="service-detail-column">
        <div className="service-detail-header-slot">
        <ResourceDetailHeader
          resourceTypeLabel=""
          title={name || '—'}
          status={status}
          statusLabel={statusLabel}
          statusColor={statusColor || 'muted'}
          statusSlot={
            <span className="service-detail-status-tools">
              <span className={`status-badge ${headerStatusClass(status, statusColor || 'muted')}`}>
                {statusLabel}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                title="Refresh service details"
                onClick={() => void runRefresh()}
                disabled={actionBarBusy}
              >
                <svg
                  width="12"
                  height="12"
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
            </span>
          }
          icon={icons.service}
          metaItems={[]}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      type="button"
                      className="action-bar-btn"
                      onClick={openMigrateDialog}
                    >
                      <span className="action-bar-btn-label">Migrate</span>
                    </button>
                    <button
                      type="button"
                      className="action-bar-btn action-bar-btn-danger"
                      onClick={() =>
                        setDeleteTarget({
                          envId: String(envId),
                          ns: namespace,
                          name,
                          // GitOps annotations — present only if deployed via Portainer Run GitOps
                          gitTargetId: d?.metadata?.annotations?.['portainer-run/git-target-id'] || null,
                          gitBranch: d?.metadata?.annotations?.['portainer-run/git-branch'] || null,
                          gitPath: d?.metadata?.annotations?.['portainer-run/git-path'] || null,
                        })
                      }
                    >
                      <span
                        className="action-bar-btn-icon"
                        dangerouslySetInnerHTML={{ __html: icons.trash }}
                      />
                      <span className="action-bar-btn-label">Delete</span>
                    </button>
                  </div>
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
      {migrateOpen ? (
        <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="migrate-title">
          <div className="modal">
            <div className="modal-head">
              <h3 id="migrate-title">Migrate stack</h3>
            </div>
            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              <div style={{ color: 'var(--text-dim)' }}>
                You can <strong>clone</strong> this stack to a new location, or <strong>move</strong> it.
                Moving may have downtime because the source deployment is removed after the target is created.
              </div>
              <div className="field">
                <label>Target environment</label>
                <select
                  value={migrateEnvId}
                  onChange={(e) => {
                    setMigrateEnvId(e.target.value)
                    setMigrateNamespace('')
                    setMigrateNsList([])
                    setMigrateNsStatus({ text: '', tone: 'dim' })
                  }}
                  disabled={migratePending}
                >
                  <option value="">— Select —</option>
                  {visEnvs.map((e) => (
                    <option key={e.Id} value={String(e.Id)}>
                      {e.Name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Target namespace</label>
                {migrateManualNs ? (
                  <input
                    type="text"
                    value={migrateManualNsValue}
                    onChange={(e) => setMigrateManualNsValue(e.target.value)}
                    placeholder="production"
                    disabled={migratePending || migrateNsLoading}
                  />
                ) : (
                  <select
                    value={migrateNamespace}
                    onChange={(e) => setMigrateNamespace(e.target.value)}
                    disabled={!migrateEnvId || migratePending || migrateNsLoading}
                  >
                    <option value="">
                      {!migrateEnvId
                        ? 'Select target first...'
                        : migrateNsLoading
                          ? 'Loading namespaces...'
                          : '— Select —'}
                    </option>
                    {migrateNsList.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                )}
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    color:
                      migrateNsStatus.tone === 'amber'
                        ? 'var(--amber)'
                        : migrateNsStatus.tone === 'green'
                          ? 'var(--green)'
                          : migrateNsStatus.tone === 'red'
                            ? 'var(--red)'
                            : 'var(--text-dim)',
                    marginTop: 4,
                  }}
                >
                  {migrateNsStatus.text}
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setMigrateOpen(false)}
                disabled={migratePending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void runMigrate('clone')}
                disabled={migratePending}
              >
                {migratePending ? 'Working…' : 'Clone'}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void runMigrate('move')}
                disabled={migratePending}
              >
                {migratePending ? 'Working…' : 'Move'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
