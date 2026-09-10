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
import { Button } from '@ds/v3-components/Button/Button'
import { Tabs } from '@ds/v3-components/Tabs/Tabs'
import type { TabItem } from '@ds/v3-components/Tabs/Tabs'

import { useAppStore } from '../../store/useAppStore.js'
import {
  useEnvStatusOnDeployments,
  getExtraForApp,
} from '../../hooks/useEnvStatus.js'
import { serviceDetailPath } from '../../lib/routes.js'
import { kubeFetch } from '../../lib/api.js'
import { patchDeploymentReplicas } from '../../lib/patchDeploymentReplicas.js'
import { restartDeployment } from '../../lib/restartDeployment.js'
import { checkEnvPermissions } from '../../lib/envPermissions.js'
import { refreshCache } from '../../services/refreshDeployments.js'
import { STACK_ID_LABEL } from '../../services/deleteApp.js'
import { errMessage } from '../../lib/errors'
import { MONO_FONT, TabPanel } from './detailUi'
import { ServiceDetailLogsTab } from './ServiceDetailLogsTab'
import { ServiceDetailMetricsTab } from './ServiceDetailMetricsTab'
import { ServiceDetailRevisionsTab } from './ServiceDetailRevisionsTab'
import { ServiceDetailEditTab } from './ServiceDetailEditTab'
import { SimpleOverview } from './SimpleOverviewTab'
import { ServiceInternalsTab } from './ServiceInternalsTab'
import { headerStatusFromDeployment } from './deploymentStatus'
import { isDeployment } from '../../types/k8s'
import type { Deployment } from '../../types/k8s'

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

export function ServiceDetailIndexRedirect() {
  const { envId = '', namespace = '', name = '' } = useParams()
  return (
    <Navigate
      to={serviceDetailPath(envId, namespace, name, 'overview')}
      replace
    />
  )
}

export function ServiceDetailPage() {
  const { envId = '', namespace = '', name = '', tab: tabParam } = useParams()
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const pushToast = useAppStore((s) => s.pushToast)
  const envPermissions = useAppStore((s) => s.envPermissions)

  const [d, setD] = useState<Deployment | null>(null)
  const [err, setErr] = useState('')
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
    envId && namespace
      ? (envPermissions[`${envId}:${namespace}`] ?? null)
      : null

  // Live status + access URL for this app, reusing the same env-status feed as
  // the Applications page. Reads from live cluster objects, not git or the DB.
  const envStatusClientCache = useAppStore((s) => s.envStatusClientCache)
  const statusDeps = useMemo(
    () =>
      d
        ? [
            {
              _envId: String(envId),
              metadata: {
                namespace,
                resourceVersion: d.metadata?.resourceVersion,
              },
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
      } catch (e: unknown) {
        setD(null)
        setErr(errMessage(e) || 'Request failed')
      } finally {
        loadInFlight.current = null
      }
    })()
    loadInFlight.current = p
    return p
  }, [token, envId, namespace, name])

  const runRestart = useCallback(async () => {
    if (!token || !envId || !namespace || !name || restartInFlight.current)
      return
    restartInFlight.current = true
    setRestartPending(true)
    try {
      const updated = await restartDeployment(
        token,
        String(envId),
        namespace,
        name,
      )
      if (isDeployment(updated)) setD(updated)
      else void load()
      pushToast(
        `“${name}” is restarting — pods will be replaced one by one`,
        'ok',
      )
      setTimeout(() => {
        void refreshCache(false)
        void load()
      }, 2000)
    } catch (e: unknown) {
      pushToast('Restart failed: ' + errMessage(e), 'err')
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
    } catch (e: unknown) {
      pushToast('Start failed: ' + errMessage(e), 'err')
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
    } catch (e: unknown) {
      pushToast('Stop failed: ' + errMessage(e), 'err')
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
      navigate(serviceDetailPath(envId, namespace, name, legacy), {
        replace: true,
      })
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
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 12,
                      wordBreak: 'break-all',
                    }}
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
                leftSection={<RefreshCw size={13} />}
                title="Refresh service details"
                onClick={() => void runRefresh()}
                disabled={actionBarBusy}
              >
                Refresh
              </Button>
              <Button
                variant="light"
                leftSection={<RotateCw size={13} />}
                title="Rolling restart — pods are replaced one by one"
                onClick={() => void runRestart()}
                disabled={!d || actionBarBusy}
              >
                Restart
              </Button>
              <Button
                variant="light"
                leftSection={<Play size={13} />}
                title="Set replicas to 1 (when scaled to zero)"
                onClick={() => void runStart()}
                disabled={!d || actionBarBusy || desired > 0}
              >
                Start
              </Button>
              <Button
                variant="light"
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
                <Button
                  variant="light"
                  color="danger"
                  leftSection={<Trash2 size={13} />}
                  // Gated on `d` as well as permissions, like Restart/Start/Stop.
                  // `perms` is cached in the store from the Applications page, so
                  // without the `d` check the button is live on first paint and
                  // after a failed load(). Every target field below is read off
                  // `d`, so a null `d` would build an all-null target: no stackId
                  // means the direct-resource path runs and orphans the stack, no
                  // git annotations means no cleanup and no checkbox, and the
                  // delete still reports success.
                  disabled={!d || !perms?.canDelete}
                  disabledReason={
                    !perms?.canDelete
                      ? 'You do not have permission to delete workloads in this environment'
                      : undefined
                  }
                  onClick={() =>
                    d &&
                    perms?.canDelete &&
                    setDeleteTarget({
                      envId: String(envId),
                      ns: namespace,
                      name,
                      // Stamped by Portainer on everything it deploys through a
                      // stack, so this resolves for pre-existing apps too.
                      stackId: d?.metadata?.labels?.[STACK_ID_LABEL] || null,
                      gitTargetId:
                        d?.metadata?.annotations?.[
                          'portainer-run/git-target-id'
                        ] || null,
                      gitBranch:
                        d?.metadata?.annotations?.[
                          'portainer-run/git-branch'
                        ] || null,
                      gitPath:
                        d?.metadata?.annotations?.['portainer-run/git-path'] ||
                        null,
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
          <Tabs
            tabs={visibleTabs}
            value={tab}
            onChange={onTabChange}
            size="sm"
          />
          <div style={{ flex: 1 }} />
          <Button
            variant="ghost"
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
              <ServiceInternalsTab
                d={d}
                token={token}
                envId={String(envId)}
                namespace={namespace!}
                name={name!}
              />
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
    </div>
  )
}
