import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'

import { Button } from '@ds/v3-components/Button/Button'
import { Badge } from '@ds/v3-components/Badge/Badge'
import { Skeleton } from '@ds/v3-components/Skeleton/Skeleton'
import { StatusDot } from '@ds/v3-components/StatusDot/StatusDot'
import type { StatusTone } from '@ds/v3-components/StatusDot/StatusDot'
import { StatusBar } from '@ds/v3-components/StatusSummary/StatusSummary'
import { SortableList } from '@ds/v3-templates/SortableList/SortableList'
import { PageTitle } from '@ds/v3-templates/PageTitle/PageTitle'

import { checkEnvPermissions } from '../lib/envPermissions.js'
import { useAppStore, visibleDeployments } from '../store/useAppStore.js'
import { ROUTES, serviceDetailPath } from '../lib/routes.js'
import {
  useEnvStatusOnDeployments,
  getExtraForApp,
} from '../hooks/useEnvStatus.js'
import { age } from '../lib/utils.js'
import { manualRefresh } from '../services/refreshDeployments.js'
import type { Deployment } from '../types/k8s'

const SERVICE_LIST_SORT = [
  { value: 'name', label: 'Name' },
  { value: 'env', label: 'Environment' },
  { value: 'status', label: 'Health' },
  { value: 'age', label: 'Created' },
]

const STATUS_SORT_ORDER = [
  'workloads_down',
  'workloads_degraded',
  'workloads_running',
  'no_workloads',
]

const SVC_STATUS_GROUP: Record<string, { name: string }> = {
  workloads_down: { name: 'Unavailable' },
  workloads_degraded: { name: 'Degraded' },
  workloads_running: { name: 'Running' },
  no_workloads: { name: 'Switched off' },
}

const SVC_STATUS_SUBFILTER_EMPTY: Record<string, string> = {
  workloads_down: 'No unavailable applications in this view.',
  workloads_degraded: 'No degraded applications in this view.',
  workloads_running: 'No running applications in this view.',
  no_workloads: 'No applications are scaled to zero in this view.',
}

interface ListItem {
  id: string
  d: Deployment
}

function rowStatus(d: Deployment): { tone: StatusTone; label: string } {
  const ready = d.status?.readyReplicas || 0
  const desired = d.spec?.replicas || 0
  const conditions = d.status?.conditions || []
  const progressing = conditions.find(
    (c: { type: string }) => c.type === 'Progressing',
  )
  if (desired === 0) return { tone: 'neutral', label: 'Switched off' }
  if (ready >= desired) return { tone: 'success', label: 'Running' }
  if (ready > 0) return { tone: 'warning', label: 'Partially up' }
  if (progressing?.status === 'True')
    return { tone: 'warning', label: 'Starting up' }
  return { tone: 'danger', label: 'Not running' }
}

/** Aligned with dashboard service rollups: replica desired state only. */
function primaryServicePartition(d: Deployment): string {
  const ready = d.status?.readyReplicas || 0
  const desired = d.spec?.replicas || 0
  if (desired === 0) return 'no_workloads'
  if (ready >= desired) return 'workloads_running'
  if (ready > 0) return 'workloads_degraded'
  return 'workloads_down'
}

function cacheStatusTone(status: string): StatusTone {
  if (status === 'loading') return 'info'
  if (status === 'fresh') return 'success'
  return 'warning'
}

function cacheStatusShortText(
  cache: { everLoaded?: boolean; lastFetch?: number | null },
  cacheStatus: string,
): string {
  if (cacheStatus === 'loading') {
    if (cache?.everLoaded) return 'Refreshing…'
    return 'Loading…'
  }
  if (cacheStatus === 'cached') return 'Showing cache — live load…'
  if (cacheStatus === 'fresh') return 'Up to date'
  if (cacheStatus === 'stale') return 'Live refresh failed'
  return '—'
}

function serviceRowId(d: Deployment): string {
  return `${d._envId}-${d.metadata.namespace}-${d.metadata.name}`
}

/* Shared grid template: Name | Environment | Project space | Health | Access |
   Deployed | Deployed by | actions.
   The header and every row are independent grids. The actions column must be a
   fixed width (not `auto`) so both resolve the same free space for the `fr`
   tracks — otherwise the empty header cell and the buttons in each row give the
   grids different free space and the headers drift out of alignment. */
const ACTIONS_COL_WIDTH = 120
const ROW_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns:
    `minmax(140px, 1.4fr) minmax(100px, 1fr) minmax(100px, 1fr) minmax(140px, 1.2fr) minmax(90px, 0.9fr) minmax(70px, 0.6fr) minmax(90px, 0.9fr) ${ACTIONS_COL_WIDTH}px`,
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
}

function ColumnHeaders() {
  const cell: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: 'var(--muted)',
    whiteSpace: 'nowrap',
  }
  return (
    <div
      style={{ ...ROW_GRID, borderBottom: '1px solid var(--border)' }}
      aria-hidden
    >
      <span style={cell}>Name</span>
      <span style={cell}>Environment</span>
      <span style={cell}>Project space</span>
      <span style={cell}>Health</span>
      <span style={cell}>Access</span>
      <span style={cell}>Deployed</span>
      <span style={cell}>Deployed by</span>
      <span />
    </div>
  )
}

interface ServiceRowProps {
  d: Deployment
  envStatusClientCache: Record<string, unknown>
  onOpen: () => void
  onViewLogs: () => void
}

function ServiceRow({
  d,
  envStatusClientCache,
  onOpen,
  onViewLogs,
}: ServiceRowProps) {
  const token = useAppStore((s) => s.token)
  const setRestartTarget = useAppStore((s) => s.setRestartTarget)
  const envPermissions = useAppStore((s) => s.envPermissions)
  const patchEnvPermissions = useAppStore((s) => s.patchEnvPermissions)
  const permKey = `${d._envId}:${d.metadata.namespace}`
  const perms = envPermissions[permKey] ?? null

  // Fire permission check for this row's env+namespace if not yet cached
  useEffect(() => {
    if (envPermissions[permKey] !== undefined) return
    const envId = d._envId
    if (envId == null) return
    void checkEnvPermissions(token, envId, d.metadata.namespace).then(
      (p: unknown) => patchEnvPermissions(envId, d.metadata.namespace, p),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permKey])

  const name = d.metadata.name
  const ns = d.metadata.namespace
  const envId = d._envId
  const envName = d._envName || '—'
  const created = d.metadata?.creationTimestamp
  const deployedBy =
    d.metadata?.labels?.['io.portainer.kubernetes.application.owner'] ||
    d.metadata?.labels?.['io.portainer.kubernetes.application.owner.id'] ||
    '—'
  const { tone, label } = rowStatus(d)
  const extra = getExtraForApp(envStatusClientCache, envId, name)

  const onRestart = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!token) return
    setRestartTarget({ envId, ns, name })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      style={{
        ...ROW_GRID,
        cursor: 'pointer',
        borderBottom: '1px solid var(--border)',
      }}
      data-svc-env={String(envId)}
      data-svc-name={name}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div
        style={{
          fontWeight: 600,
          color: 'var(--text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </div>
      <div title={envName}>
        <Badge tone="neutral" size="sm">
          {envName}
        </Badge>
      </div>
      <div>
        <Badge tone="neutral" size="sm">
          {ns}
        </Badge>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--text)',
          }}
        >
          <StatusDot tone={tone} />
          {label}
          {(d.spec?.replicas ?? 0) > 1 && (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {d.status?.readyReplicas || 0}/{d.spec?.replicas}
            </span>
          )}
        </span>
        {extra.reason ? (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {extra.reason}
          </span>
        ) : null}
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        {extra.accessUrl ? (
          <a
            href={extra.accessUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={extra.accessLabel || extra.accessUrl}
            style={{
              color: 'var(--accent, #2e90fa)',
              fontSize: 12,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Launch
          </a>
        ) : extra.accessLabel ? (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {extra.accessLabel}
          </span>
        ) : (
          <span style={{ color: 'var(--muted)' }}>—</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{age(created)}</div>
      <div
        title={deployedBy}
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {deployedBy}
      </div>
      <div
        style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          onClick={onViewLogs}
          disabled={!perms?.canViewLogs}
          title={
            !perms?.canViewLogs
              ? 'You do not have permission to view logs in this environment'
              : undefined
          }
        >
          Logs
        </Button>
        <Button
          variant="ghost"
          onClick={onRestart}
          disabled={!perms?.canRestart}
          title={
            !perms?.canRestart
              ? 'You do not have permission to restart workloads in this environment'
              : undefined
          }
        >
          Restart
        </Button>
      </div>
    </div>
  )
}

export function ServicesPage() {
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const cache = useAppStore((s) => s.cache)
  const cacheStatus = useAppStore((s) => s.cacheStatus)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const envStatusClientCache = useAppStore((s) => s.envStatusClientCache)

  const [listQuery, setListQuery] = useState<Record<string, string>>({
    sortBy: 'name',
    filter: '',
    page: '1',
  })
  const listSort = listQuery.sortBy
  const [listSubFilter, setListSubFilter] = useState<string | null>(null)

  const deps = useMemo(
    () => visibleDeployments(useAppStore.getState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [environments, disabledEnvs, cache.deployments],
  )
  useEnvStatusOnDeployments(deps, token)

  const listItems: ListItem[] = useMemo(() => {
    const base = deps.map((d: Deployment) => ({ id: serviceRowId(d), d }))
    if (listSort === 'name') {
      return [...base].sort((a, b) =>
        a.d.metadata.name.localeCompare(b.d.metadata.name, undefined, {
          sensitivity: 'base',
        }),
      )
    }
    if (listSort === 'env') {
      return [...base].sort((a, b) => {
        const ea = a.d._envName || ''
        const eb = b.d._envName || ''
        if (ea !== eb)
          return ea.localeCompare(eb, undefined, { sensitivity: 'base' })
        return a.d.metadata.name.localeCompare(b.d.metadata.name, undefined, {
          sensitivity: 'base',
        })
      })
    }
    if (listSort === 'status') {
      const orderIdx = (x: ListItem) =>
        STATUS_SORT_ORDER.indexOf(primaryServicePartition(x.d))
      return [...base].sort((a, b) => {
        const ia = orderIdx(a)
        const ib = orderIdx(b)
        if (ia !== ib) return ia - ib
        return a.d.metadata.name.localeCompare(b.d.metadata.name, undefined, {
          sensitivity: 'base',
        })
      })
    }
    if (listSort === 'age') {
      return [...base].sort((a, b) => {
        const at = new Date(a.d.metadata?.creationTimestamp || 0).getTime()
        const bt = new Date(b.d.metadata?.creationTimestamp || 0).getTime()
        return bt - at // newest first
      })
    }
    return base
  }, [deps, listSort])

  /* Sub-filter (from the summary bar) narrows the list to one health
     partition; only active while sorting by Health, like the old UI. */
  const visibleItems = useMemo(() => {
    if (!listSubFilter || listSort !== 'status') return listItems
    return listItems.filter(
      (item) => primaryServicePartition(item.d) === listSubFilter,
    )
  }, [listItems, listSubFilter, listSort])

  const summary = useMemo(() => {
    const total = deps.length
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
  }, [deps])

  function selectSubFilter(partition: string | null) {
    if (partition === null || listSubFilter === partition) {
      setListSubFilter(null)
      return
    }
    setListQuery((q) => ({ ...q, sortBy: 'status', page: '1' }))
    setListSubFilter(partition)
  }

  const initialLoading =
    !cache.deployments.length && cache.fetching && !cache.everLoaded
  const showEmpty = !initialLoading && !deps.length

  const emptyMessage =
    listSubFilter && listSort === 'status'
      ? SVC_STATUS_SUBFILTER_EMPTY[listSubFilter] ||
        'No applications match this filter.'
      : 'No applications match'

  return (
    <div className="ash-content">
      <div style={{ marginBottom: 20 }}>
        <PageTitle
          title="Applications"
          description="Your deployed applications, across all environments"
          actions={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                title={
                  cacheStatus === 'cached'
                    ? 'Data was restored from your last session; fetching live data from the cluster'
                    : undefined
                }
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: 'var(--muted)',
                  whiteSpace: 'nowrap',
                }}
              >
                <StatusDot
                  tone={cacheStatusTone(cacheStatus)}
                  animation={cacheStatus === 'loading' ? 'pulse' : 'static'}
                />
                {cacheStatusShortText(cache, cacheStatus)}
              </span>
              <Button
                variant="ghost"
                leftSection={<RefreshCw size={13} />}
                onClick={() => void manualRefresh()}
              >
                Refresh
              </Button>
              <Button onClick={() => navigate(ROUTES.deploy)}>
                + Deploy
              </Button>
            </div>
          }
        />
      </div>

      <div style={{ marginBottom: 24 }}>
        <StatusBar
          items={[
            {
              label: 'Total applications',
              value: summary.total,
              active: false,
              onClick: () => selectSubFilter(null),
            },
            {
              label: 'Running',
              value: summary.running,
              tone: 'success',
              active: listSubFilter === 'workloads_running',
              onClick: () => selectSubFilter('workloads_running'),
            },
            {
              label: 'Degraded',
              value: summary.degraded,
              tone: 'warning',
              active: listSubFilter === 'workloads_degraded',
              onClick: () => selectSubFilter('workloads_degraded'),
            },
            {
              label: 'Unavailable',
              value: summary.unavailable,
              tone: 'danger',
              active: listSubFilter === 'workloads_down',
              onClick: () => selectSubFilter('workloads_down'),
            },
          ]}
        />
      </div>

      {showEmpty ? (
        <div
          style={{
            textAlign: 'center',
            padding: '48px 0',
            color: 'var(--muted)',
          }}
        >
          <h3 style={{ margin: '0 0 6px', color: 'var(--text)' }}>
            No deployments found
          </h3>
          <p style={{ margin: 0 }}>Deploy an application to get started.</p>
        </div>
      ) : null}

      {initialLoading ? (
        <div aria-busy>
          <ColumnHeaders />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={ROW_GRID}>
              <Skeleton height={16} />
              <Skeleton height={16} />
              <Skeleton height={16} />
              <Skeleton height={16} />
              <Skeleton height={16} />
              <Skeleton height={16} />
              <Skeleton height={16} />
              <span />
            </div>
          ))}
        </div>
      ) : null}

      {!initialLoading && deps.length > 0 ? (
        <SortableList<ListItem>
          items={visibleItems}
          sortOptions={SERVICE_LIST_SORT}
          defaultSort="name"
          routeQuery={listQuery}
          onRouteChange={setListQuery}
          searchPlaceholder="Filter applications…"
          emptyMessage={emptyMessage}
          getItemGroup={(item, sortBy) =>
            sortBy === 'status' ? primaryServicePartition(item.d) : null
          }
          getGroupInfo={(key) => SVC_STATUS_GROUP[key] ?? { name: String(key) }}
          getGroupOrder={(sortBy) =>
            sortBy === 'status' ? STATUS_SORT_ORDER : null
          }
          filterItem={(item, q) => {
            const envN = item.d._envName || ''
            const n = item.d.metadata.name
            const { label } = rowStatus(item.d)
            return `${n} ${envN} ${label}`.toLowerCase().includes(q)
          }}
          renderColumnHeaders={() => <ColumnHeaders />}
          renderItem={(item) => (
            <ServiceRow
              key={item.id}
              d={item.d}
              envStatusClientCache={envStatusClientCache}
              onOpen={() =>
                navigate(
                  serviceDetailPath(
                    String(item.d._envId),
                    item.d.metadata.namespace,
                    item.d.metadata.name,
                    'overview',
                  ),
                )
              }
              onViewLogs={() =>
                navigate(
                  serviceDetailPath(
                    String(item.d._envId),
                    item.d.metadata.namespace,
                    item.d.metadata.name,
                    'logs',
                  ),
                )
              }
            />
          )}
        />
      ) : null}
    </div>
  )
}
