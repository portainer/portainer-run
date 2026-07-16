import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  Boxes,
  Clock,
  FileText,
  LayoutDashboard,
  MonitorPlay,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Trash2,
} from 'lucide-react'

import { ResourceDetailHeader } from '@ds/v3-templates/ResourceDetailHeader/ResourceDetailHeader'
import type { BadgeTone } from '@ds/v3-components/Badge/Badge'
import { Button } from '@ds/v3-components/Button/Button'
import { Tabs } from '@ds/v3-components/Tabs/Tabs'
import type { TabItem } from '@ds/v3-components/Tabs/Tabs'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from '@ds/v3-components/Dialog/Dialog'
import { FormControl, Input } from '@ds/v3-components/FormField/FormField'
import { Select } from '@ds/v3-components/Select/Select'
import { StatusDot } from '@ds/v3-components/StatusDot/StatusDot'

import { useAppStore, visibleEnvironments } from '../../store/useAppStore.js'
import {
  useEnvStatusOnDeployments,
  getExtraForApp,
} from '../../hooks/useEnvStatus.js'
import { serviceDetailPath } from '../../lib/routes.js'
import { kubeFetch } from '../../lib/api.js'
import { age } from '../../lib/utils.js'
import { patchDeploymentReplicas } from '../../lib/patchDeploymentReplicas.js'
import { restartDeployment } from '../../lib/restartDeployment.js'
import { checkEnvPermissions } from '../../lib/envPermissions.js'
import { refreshCache } from '../../services/refreshDeployments.js'
import { loadDeployFormFromCluster } from '../../lib/deployFormLoadFromCluster.js'
import {
  buildK8sContainer,
  executeDeploy,
  fetchNamespaceOptions,
  readVolumeDefForDeploy,
} from '../../lib/deployK8s.js'
import { withDefaultCnames } from '../../lib/deployFormModel.js'
import { fetchExposureDetail } from './fetchExposureDetail.js'
import { Kv, MONO_FONT, Section, TabPanel } from './detailUi'
import { ServiceDetailLogsTab } from './ServiceDetailLogsTab'
import { ServiceDetailMetricsTab } from './ServiceDetailMetricsTab'
import { ServiceDetailRevisionsTab } from './ServiceDetailRevisionsTab'
import { ServiceDetailEditTab } from './ServiceDetailEditTab'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Deployment = any

/** Match old-implementation: Overview → Containers → Metrics → Logs → Revisions → Edit */
const SIMPLE_TABS: TabItem[] = [
  { value: 'overview', label: 'Overview', icon: LayoutDashboard },
  { value: 'metrics', label: 'Metrics', icon: MonitorPlay },
  { value: 'logs', label: 'Logs', icon: FileText },
  { value: 'edit', label: 'Edit', icon: Pencil },
]

const TECH_TABS: TabItem[] = [
  { value: 'app-internals', label: 'App internals', icon: Boxes },
  { value: 'revisions', label: 'Revisions', icon: Clock },
]

const ALL_TABS = [...SIMPLE_TABS, ...TECH_TABS]
const TECH_TAB_IDS = new Set(TECH_TABS.map((t) => t.value))
const VALID_TABS = new Set(ALL_TABS.map((t) => t.value))

const LEGACY_TAB_REDIRECT: Record<string, string> = {
  details: 'overview',
  events: 'overview',
  yaml: 'overview',
  containers: 'app-internals',
}

function OverviewExposure({
  token,
  envId,
  namespace,
  name,
}: {
  token: string
  envId: string
  namespace: string
  name: string
}) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<[string, string][]>([])
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

  const dim = { color: 'var(--muted)', fontSize: 12 }
  if (loading) return <span style={dim}>Loading…</span>
  if (exErr) return <span style={dim}>Could not load exposure: {exErr}</span>
  if (emptyMessage) return <span style={dim}>{emptyMessage}</span>
  return <Kv pairs={rows} />
}

function headerStatusFromDeployment(d: Deployment): {
  status: string
  statusLabel: string
  statusTone: BadgeTone
} {
  if (!d) {
    return { status: '', statusLabel: 'Loading…', statusTone: 'neutral' }
  }
  const ready = d.status?.readyReplicas || 0
  const desired = d.spec?.replicas || 0
  const conditions = d.status?.conditions || []
  const progressing = conditions.find(
    (c: { type: string }) => c.type === 'Progressing',
  )
  if (desired === 0) {
    return { status: 'stopped', statusLabel: 'Switched off', statusTone: 'neutral' }
  }
  if (ready >= desired) {
    return { status: 'running', statusLabel: 'Running', statusTone: 'success' }
  }
  if (ready > 0) {
    return { status: 'partial', statusLabel: 'Degraded', statusTone: 'warning' }
  }
  if (progressing?.status === 'True') {
    return { status: 'pending', statusLabel: 'Starting', statusTone: 'warning' }
  }
  return { status: 'error', statusLabel: 'Not available', statusTone: 'danger' }
}

// Keys whose values are treated as sensitive and masked by default.
const SECRET_PATTERN = /SECRET|KEY|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL/i

// Plain-language, business-builder friendly status line for the simple Overview.
function friendlyStatus(d: Deployment, reason: string | undefined) {
  const { status, statusLabel } = headerStatusFromDeployment(d)
  const base =
    status === 'running' ? 'Your app is live and running.'
      : status === 'stopped' ? 'Your app is switched off.'
      : status === 'pending' ? 'Your app is starting up.'
      : status === 'partial' ? 'Your app is running, but not fully healthy.'
      : status === 'error' ? "Your app isn't running right now."
      : statusLabel
  return { status, base, reason: reason || '' }
}

// Display value for an env entry, resolving valueFrom references to a note.
function envDisplayValue(e: any): string {
  if (e.value != null) return e.value
  if (e.valueFrom?.secretKeyRef) {
    const r = e.valueFrom.secretKeyRef
    return `secret(${r.name}/${r.key})`
  }
  if (e.valueFrom?.configMapKeyRef) {
    const r = e.valueFrom.configMapKeyRef
    return `configmap(${r.name}/${r.key})`
  }
  if (e.valueFrom?.fieldRef) return '(fieldRef)'
  if (e.valueFrom?.resourceFieldRef) return '(resourceFieldRef)'
  return '*'
}

// A single env value with click-to-reveal masking for secret-pattern keys.
function EnvValue({ envKey, value }: { envKey: string; value: string }) {
  const [revealed, setRevealed] = useState(false)
  const isSecret = SECRET_PATTERN.test(envKey)
  const mono = { fontFamily: MONO_FONT, fontSize: 12, wordBreak: 'break-all' as const }
  if (!isSecret) {
    return <span style={mono}>{value}</span>
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={mono}>{revealed ? value : '••••••••'}</span>
      <Button variant="ghost" size="xs" onClick={() => setRevealed((r) => !r)}>
        {revealed ? 'Hide' : 'Reveal'}
      </Button>
    </span>
  )
}

/**
 * Simple, business-builder Overview. Reads everything from the live cluster
 * objects already in hand (deployment + env-status cache), so it has no
 * dependency on the git target or the local database.
 */
function SimpleOverview({ d, extra }: { d: Deployment; extra: any }) {
  const { status, base, reason } = friendlyStatus(d, extra?.reason)
  const container = d.spec?.template?.spec?.containers?.[0]
  const envs = (container?.env || [])
    .filter((e: any) => e && typeof e.name === 'string' && e.value != null)
    .map((e: any) => ({ key: e.name, value: String(e.value) }))
  const tone =
    status === 'running' ? 'success'
      : status === 'error' ? 'danger'
      : status === 'stopped' ? 'neutral'
      : 'warning'

  const accessUrl = extra?.accessUrl || null
  const accessLabel = extra?.accessLabel || null

  return (
    <>
      <Section title="Status">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StatusDot tone={tone} />
          <span style={{ fontSize: 14 }}>{base}</span>
        </div>
        {reason && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
            {reason}
          </div>
        )}
      </Section>

      <Section title="Address">
        {accessUrl ? (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}
          >
            <Button onClick={() => window.open(accessUrl, '_blank', 'noopener,noreferrer')}>
              Open your app
            </Button>
            <a
              href={accessUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: MONO_FONT,
                fontSize: 12,
                color: 'var(--muted)',
                wordBreak: 'break-all',
              }}
            >
              {accessUrl}
            </a>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {accessLabel || 'Not exposed publicly.'}
          </div>
        )}
      </Section>

      <Section title="Environment variables">
        {envs.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            No environment variables set.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(120px, 220px) 1fr',
              gap: '8px 16px',
              alignItems: 'center',
            }}
          >
            {envs.map((e: { key: string; value: string }, i: number) => (
              <div key={`${e.key}-${i}`} style={{ display: 'contents' }}>
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: 'var(--muted)',
                    wordBreak: 'break-all',
                  }}
                >
                  {e.key}
                </div>
                <div>
                  <EnvValue envKey={e.key} value={e.value} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

export function ServiceDetailIndexRedirect() {
  const { envId = '', namespace = '', name = '' } = useParams()
  return (
    <Navigate to={serviceDetailPath(envId, namespace, name, 'overview')} replace />
  )
}

export function ServiceDetailPage() {
  const { envId = '', namespace = '', name = '', tab: tabParam } = useParams()
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const pushToast = useAppStore((s) => s.pushToast)
  const envPermissions = useAppStore((s) => s.envPermissions)

  const [d, setD] = useState<Deployment | null>(null)
  const [err, setErr] = useState('')
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [migrateEnvId, setMigrateEnvId] = useState(String(envId || ''))
  const [migrateNamespace, setMigrateNamespace] = useState('')
  const [migrateManualNs, setMigrateManualNs] = useState(false)
  const [migrateManualNsValue, setMigrateManualNsValue] = useState(namespace || '')
  const [migrateNsList, setMigrateNsList] = useState<string[]>([])
  const [migrateNsLoading, setMigrateNsLoading] = useState(false)
  const [migrateNsStatus, setMigrateNsStatus] = useState<{
    text: string
    tone: string
  }>({ text: '', tone: 'dim' })
  const [migratePending, setMigratePending] = useState(false)
  const [refreshPending, setRefreshPending] = useState(false)
  const [restartPending, setRestartPending] = useState(false)
  const [scalePending, setScalePending] = useState(false)
  const loadInFlight = useRef<Promise<void> | null>(null)
  const refreshInFlight = useRef(false)
  const restartInFlight = useRef(false)
  const scaleInFlight = useRef(false)

  const tab = tabParam || 'overview'
  const patchEnvPermissions = useAppStore((s) => s.patchEnvPermissions)
  const perms =
    envId && namespace ? (envPermissions[`${envId}:${namespace}`] ?? null) : null

  // Live status + access URL for this app, reusing the same env-status feed as
  // the Applications page. Reads from live cluster objects, not git or the DB.
  const envStatusClientCache = useAppStore((s) => s.envStatusClientCache)
  const statusDeps = useMemo(
    () =>
      d
        ? [
            {
              _envId: String(envId),
              metadata: { namespace, resourceVersion: d.metadata?.resourceVersion },
            },
          ]
        : [],
    [d, envId, namespace],
  )
  useEnvStatusOnDeployments(statusDeps, token)
  const extra = getExtraForApp(envStatusClientCache, String(envId), name)

  // Technical detail reveal. Ephemeral: resets on every visit, not persisted.
  const [technical, setTechnical] = useState(() => TECH_TAB_IDS.has(tab))
  useEffect(() => {
    if (TECH_TAB_IDS.has(tab)) setTechnical(true)
  }, [tab])

  // Fire permission check on mount using known env+namespace
  useEffect(() => {
    if (!token || !envId || !namespace) return
    const key = `${envId}:${namespace}`
    if (envPermissions[key] !== undefined) return
    void checkEnvPermissions(token, envId, namespace).then((p: unknown) =>
      patchEnvPermissions(envId, namespace, p),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envId, namespace])

  const visEnvs = useMemo(
    () => visibleEnvironments({ environments, disabledEnvs }),
    [environments, disabledEnvs],
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
      } catch (e: any) {
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
    } catch (e: any) {
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
    async (targetEnv: string) => {
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
          setMigrateNsStatus({
            text: r.message || `${list.length} namespace(s)`,
            tone: 'green',
          })
        } else {
          setMigrateNsList([])
          setMigrateManualNs(true)
          setMigrateNamespace('')
          setMigrateNsStatus({
            text: r.error || 'Failed to fetch namespaces',
            tone: 'red',
          })
        }
      } catch (e: any) {
        setMigrateNsList([])
        setMigrateManualNs(true)
        setMigrateNamespace('')
        setMigrateNsStatus({
          text: e?.message || 'Error loading namespaces',
          tone: 'red',
        })
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

  const runMigrate = useCallback(
    async (mode: 'clone' | 'move') => {
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
        const loaded = await loadDeployFormFromCluster(
          token,
          String(envId),
          namespace,
          name,
        )
        const forBuild = withDefaultCnames(loaded.containers || [])
        const pairs = forBuild
          .map((c: any) => {
            const spec = buildK8sContainer(c)
            return spec ? { id: c.id, spec } : null
          })
          .filter(Boolean) as { id: string; spec: unknown }[]
        if (!pairs.length) throw new Error('No containers found to migrate')
        const volDefs = forBuild
          .map((c: any) => readVolumeDefForDeploy(c))
          .filter(Boolean)
        const servicePorts = (loaded.svcPorts || [])
          .map((p: unknown) => parseInt(String(p), 10))
          .filter((n: number) => n > 0)
        // executeDeploy's JSDoc only annotates containerRowIds, so TS rejects
        // the full options object; the shape matches what the JS expects.
        await executeDeploy(token, {
          envId: targetEnv,
          ns: targetNs,
          appName: name,
          instances: Math.max(
            0,
            Math.min(100, parseInt(String(loaded.instances), 10) || 1),
          ),
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
        } as any)
        if (mode === 'move') {
          const del = await kubeFetch(
            token,
            String(envId),
            `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
            { method: 'DELETE' },
          )
          if (!del.ok && del.status !== 404) {
            throw new Error(
              'Cloned successfully, but delete failed (HTTP ' + del.status + ')',
            )
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
          navigate(serviceDetailPath(targetEnv, targetNs, name, 'overview'), {
            replace: true,
          })
        }
      } catch (e: any) {
        pushToast(
          (mode === 'move' ? 'Move' : 'Clone') +
            ' failed: ' +
            (e?.message || String(e)),
          'err',
        )
      } finally {
        setMigratePending(false)
      }
    },
    [
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
    ],
  )

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
    } catch (e: any) {
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
    } catch (e: any) {
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
      navigate(serviceDetailPath(envId, namespace, name, 'overview'), {
        replace: true,
      })
    }
  }, [tabParam, envId, namespace, name, navigate])

  const onTabChange = useCallback(
    (id: string) => {
      navigate(serviceDetailPath(envId, namespace, name, id))
    },
    [navigate, envId, namespace, name],
  )

  const toggleTechnical = useCallback(() => {
    setTechnical((prev) => {
      const next = !prev
      // If hiding while on a technical tab, return to the simple Overview so the
      // tab bar and body stay in sync.
      if (!next && TECH_TAB_IDS.has(tab)) {
        navigate(serviceDetailPath(envId, namespace, name, 'overview'))
      }
      return next
    })
  }, [tab, navigate, envId, namespace, name])

  const visibleTabs = technical ? ALL_TABS : SIMPLE_TABS

  const { statusLabel, statusTone } = useMemo(
    () => headerStatusFromDeployment(d),
    [d],
  )

  const cCount = d?.spec?.template?.spec?.containers?.length || 0
  const ready = d?.status?.readyReplicas || 0
  const desired = d?.spec?.replicas || 0
  const dotOk = desired > 0 && ready >= desired

  const image = d?.spec?.template?.spec?.containers?.[0]?.image

  return (
    <div className="ash-content">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ResourceDetailHeader
          title={name || '—'}
          statusTone={statusTone}
          statusLabel={statusLabel}
          meta={
            image
              ? [
                  <span
                    key="image"
                    title={image}
                    style={{ fontFamily: MONO_FONT, fontSize: 12, wordBreak: 'break-all' }}
                  >
                    {image}
                  </span>,
                  <span key="containers">Containers: {cCount || 0}</span>,
                ]
              : [<span key="containers">Containers: {cCount || 0}</span>]
          }
          syncStatus={
            d
              ? {
                  label: 'Replicas',
                  value: `${desired === 0 ? 0 : ready} / ${desired}`,
                  tone: dotOk ? 'success' : 'danger',
                }
              : undefined
          }
          primaryActions={
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <Button
                variant="light"
                size="sm"
                leftSection={<RefreshCw size={13} />}
                title="Refresh service details"
                onClick={() => void runRefresh()}
                disabled={actionBarBusy}
              >
                Refresh
              </Button>
              <Button
                variant="light"
                size="sm"
                leftSection={<RotateCw size={13} />}
                title="Rolling restart — pods are replaced one by one"
                onClick={() => void runRestart()}
                disabled={!d || actionBarBusy}
              >
                Restart
              </Button>
              <Button
                variant="light"
                size="sm"
                leftSection={<Play size={13} />}
                title="Set replicas to 1 (when scaled to zero)"
                onClick={() => void runStart()}
                disabled={!d || actionBarBusy || desired > 0}
              >
                Start
              </Button>
              <Button
                variant="light"
                size="sm"
                leftSection={<Pause size={13} />}
                title="Scale to zero replicas (workloads off)"
                onClick={() => void runStop()}
                disabled={!d || actionBarBusy || desired === 0}
              >
                Stop
              </Button>
              {actionBarBusy ? (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {actionBarPendingLabel}
                </span>
              ) : null}
            </div>
          }
          secondaryActions={
            actionBarBusy ? null : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {technical && (
                  <Button variant="light" size="sm" onClick={openMigrateDialog}>
                    Migrate
                  </Button>
                )}
                <Button
                  variant="light"
                  color="danger"
                  size="sm"
                  leftSection={<Trash2 size={13} />}
                  disabled={!perms?.canDelete}
                  title={
                    !perms?.canDelete
                      ? 'You do not have permission to delete workloads in this environment'
                      : undefined
                  }
                  onClick={() =>
                    perms?.canDelete &&
                    setDeleteTarget({
                      envId: String(envId),
                      ns: namespace,
                      name,
                      gitTargetId:
                        d?.metadata?.annotations?.['portainer-run/git-target-id'] ||
                        null,
                      gitBranch:
                        d?.metadata?.annotations?.['portainer-run/git-branch'] ||
                        null,
                      gitPath:
                        d?.metadata?.annotations?.['portainer-run/git-path'] || null,
                      vibeSourcePath:
                        d?.metadata?.annotations?.[
                          'portainer-run/vibe-source-path'
                        ] || null,
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            )
          }
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Tabs tabs={visibleTabs} value={tab} onChange={onTabChange} size="sm" />
          <div style={{ flex: 1 }} />
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTechnical}
            aria-expanded={technical}
          >
            {technical ? 'Hide technical details' : 'Show technical details'}
          </Button>
        </div>

        <div>
          {err && !d ? (
            <p style={{ color: 'var(--status-danger, #f04438)' }} role="alert">
              {err}
            </p>
          ) : null}

          {tab === 'overview' && d && (
            <TabPanel>
              <SimpleOverview d={d} extra={extra} />
            </TabPanel>
          )}

          {tab === 'app-internals' && d && (
            <TabPanel>
              <Section title="Status">
                {(() => {
                  const r = d.status?.readyReplicas || 0
                  const des = d.spec?.replicas || 0
                  const cond = (d.status?.conditions || []).find(
                    (c: { type: string; status: string }) =>
                      c.type === 'Available' && c.status === 'False',
                  )
                  const statusKv: [string, React.ReactNode][] = [
                    ['Ready instances', des === 0 ? 'Scaled to zero' : `${r} / ${des}`],
                    ['Updated instances', d.status?.updatedReplicas || 0],
                    ['Available instances', d.status?.availableReplicas || 0],
                    ['Observed generation', d.status?.observedGeneration || 0],
                  ]
                  if (cond) statusKv.push(['Failure reason', cond.message || '—'])
                  return <Kv pairs={statusKv} />
                })()}
              </Section>
              <Section title="Configuration">
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
              </Section>
              <Section title="Environment variables">
                {(() => {
                  const env = d.spec?.template?.spec?.containers?.[0]?.env || []
                  const pairs: [string, React.ReactNode][] = env.length
                    ? env.map((e: any) => [e.name, envDisplayValue(e)])
                    : [['(none)', '—']]
                  return <Kv pairs={pairs} />
                })()}
              </Section>
              <Section title="Exposure">
                <OverviewExposure
                  token={token}
                  envId={String(envId)}
                  namespace={namespace!}
                  name={name!}
                />
              </Section>
              <Section title="Labels">
                <Kv
                  pairs={
                    Object.keys(d.metadata?.labels || {}).length
                      ? (Object.entries(d.metadata.labels) as [string, string][])
                      : [['(none)', '—']]
                  }
                />
              </Section>
              <Section title="Containers">
                {(d.spec?.template?.spec?.containers || []).length === 0 ? (
                  <p style={{ color: 'var(--muted)' }}>No containers.</p>
                ) : (
                  (d.spec?.template?.spec?.containers || []).map(
                    (c: any, i: number) => {
                      const ports =
                        (c.ports || [])
                          .map(
                            (p: any) => `${p.containerPort}/${p.protocol || 'TCP'}`,
                          )
                          .join(', ') || '—'
                      const res = c.resources || {}
                      const mounts = (c.volumeMounts || [])
                        .map((v: any) => v.mountPath + ' → ' + v.name)
                        .join(', ')
                      return (
                        <div
                          key={c.name || i}
                          style={{
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-lg, 8px)',
                            marginBottom: 12,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              padding: '8px 12px',
                              borderBottom: '1px solid var(--border)',
                              background: 'var(--bg)',
                            }}
                          >
                            <span
                              style={{
                                fontFamily: MONO_FONT,
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              {c.name}
                            </span>
                            <span
                              style={{
                                fontFamily: MONO_FONT,
                                fontSize: 10,
                                color:
                                  i === 0
                                    ? 'var(--accent, #2e90fa)'
                                    : 'var(--muted)',
                              }}
                            >
                              {i === 0 ? 'primary' : 'sidecar'}
                            </span>
                          </div>
                          <div style={{ padding: 12 }}>
                            <Kv
                              pairs={[
                                ['Image', c.image],
                                ['Ports', ports],
                                ['Pull policy', c.imagePullPolicy || 'IfNotPresent'],
                                [
                                  'CPU request/limit',
                                  `${res.requests?.cpu || '—'} / ${res.limits?.cpu || '—'}`,
                                ],
                                [
                                  'Mem request/limit',
                                  `${res.requests?.memory || '—'} / ${res.limits?.memory || '—'}`,
                                ],
                                ['Volume mounts', mounts || '—'],
                              ]}
                            />
                          </div>
                        </div>
                      )
                    },
                  )
                )}
              </Section>
            </TabPanel>
          )}

          {tab === 'metrics' && d && (
            <TabPanel>
              <ServiceDetailMetricsTab
                d={d}
                envId={String(envId)}
                namespace={namespace!}
                name={name!}
              />
            </TabPanel>
          )}

          {tab === 'logs' && d && (
            <TabPanel>
              <ServiceDetailLogsTab
                envId={String(envId)}
                namespace={namespace!}
                name={name!}
              />
            </TabPanel>
          )}

          {tab === 'revisions' && d && (
            <TabPanel>
              <ServiceDetailRevisionsTab
                envId={String(envId)}
                namespace={namespace!}
                name={name!}
                onAfterRollback={load}
              />
            </TabPanel>
          )}

          {tab === 'edit' && d && (
            <TabPanel>
              <ServiceDetailEditTab
                d={d}
                envId={String(envId)}
                namespace={namespace!}
                name={name!}
                onSaved={load}
              />
            </TabPanel>
          )}
        </div>
      </div>

      <Dialog open={migrateOpen} onClose={() => setMigrateOpen(false)} width={480}>
        <DialogHeader title="Migrate stack" onClose={() => setMigrateOpen(false)} />
        <DialogBody>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              You can <strong>clone</strong> this stack to a new location, or{' '}
              <strong>move</strong> it. Moving may have downtime because the source
              deployment is removed after the target is created.
            </div>
            <FormControl label="Target environment">
              <Select
                value={migrateEnvId}
                onChange={(e) => {
                  setMigrateEnvId(e.target.value)
                  setMigrateNamespace('')
                  setMigrateNsList([])
                  setMigrateNsStatus({ text: '', tone: 'dim' })
                }}
                disabled={migratePending}
                options={[
                  { value: '', label: '— Select —' },
                  ...visEnvs.map((e: any) => ({
                    value: String(e.Id),
                    label: e.Name,
                  })),
                ]}
              />
            </FormControl>
            <FormControl label="Target namespace">
              {migrateManualNs ? (
                <Input
                  type="text"
                  value={migrateManualNsValue}
                  onChange={(e) => setMigrateManualNsValue(e.target.value)}
                  placeholder="production"
                  disabled={migratePending || migrateNsLoading}
                />
              ) : (
                <Select
                  value={migrateNamespace}
                  onChange={(e) => setMigrateNamespace(e.target.value)}
                  disabled={!migrateEnvId || migratePending || migrateNsLoading}
                  options={[
                    {
                      value: '',
                      label: !migrateEnvId
                        ? 'Select target first...'
                        : migrateNsLoading
                          ? 'Loading namespaces...'
                          : '— Select —',
                    },
                    ...migrateNsList.map((n) => ({ value: n, label: n })),
                  ]}
                />
              )}
              <div
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                  color:
                    migrateNsStatus.tone === 'amber'
                      ? 'var(--status-warning, #f79009)'
                      : migrateNsStatus.tone === 'green'
                        ? 'var(--status-success, #12b76a)'
                        : migrateNsStatus.tone === 'red'
                          ? 'var(--status-danger, #f04438)'
                          : 'var(--muted)',
                  marginTop: 4,
                }}
              >
                {migrateNsStatus.text}
              </div>
            </FormControl>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMigrateOpen(false)}
            disabled={migratePending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void runMigrate('clone')}
            disabled={migratePending}
          >
            {migratePending ? 'Working…' : 'Clone'}
          </Button>
          <Button
            color="danger"
            size="sm"
            onClick={() => void runMigrate('move')}
            disabled={migratePending}
          >
            {migratePending ? 'Working…' : 'Move'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
