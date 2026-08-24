import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUpDown, Check, Eye, ListFilter, RefreshCw } from 'lucide-react'

import { Button } from '@ds/v3-components/Button/Button'
import { Badge } from '@ds/v3-components/Badge/Badge'
import { StatusDot } from '@ds/v3-components/StatusDot/StatusDot'
import type { StatusTone } from '@ds/v3-components/StatusDot/StatusDot'
import { StatusBar } from '@ds/v3-components/StatusSummary/StatusSummary'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSection,
} from '@ds/v3-components/DropdownMenu/DropdownMenu'
import { DataTableCard } from '@ds/v3-templates/DataTableInCard/DataTableInCard'
import type { ColumnDef, SortDir } from '@ds/v3-components/DataTable/DataTable'
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

const PAGE_SIZE = 15

/* Sort values double as DataTable column keys, so a column header click and
   the Sort menu drive the same state. */
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

const SVC_STATUS_SUBFILTER_EMPTY: Record<string, string> = {
  workloads_down: 'No unavailable applications in this view.',
  workloads_degraded: 'No degraded applications in this view.',
  workloads_running: 'No running applications in this view.',
  no_workloads: 'No applications are scaled to zero in this view.',
}

/* Columns the View menu can hide. Name and the actions column are always on —
   a row without its name is unidentifiable, and actions carries the only
   per-row controls. */
const HIDEABLE_COLUMNS = [
  { key: 'env', label: 'Environment' },
  { key: 'ns', label: 'Project space' },
  { key: 'status', label: 'Health' },
  { key: 'access', label: 'Access' },
  { key: 'age', label: 'Deployed' },
  { key: 'owner', label: 'Deployed by' },
]

/* Which columns are hidden is a durable preference, not part of the query —
   it survives reloads, unlike the sort/filter/page state in `listQuery`.
   Same storage conventions as lib/favorites.ts. */
const HIDDEN_COLUMNS_STORAGE_KEY = 'portainer-run.applications.hiddenColumns'

function readHiddenColumns(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(HIDDEN_COLUMNS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Drop anything that is no longer a hideable column, so a renamed or
    // removed column can't leave a permanently hidden ghost in storage.
    const valid = new Set(HIDEABLE_COLUMNS.map((c) => c.key))
    return parsed.filter((k) => typeof k === 'string' && valid.has(k))
  } catch {
    return []
  }
}

function writeHiddenColumns(next: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      HIDDEN_COLUMNS_STORAGE_KEY,
      JSON.stringify(next),
    )
  } catch {
    /* storage full / disabled — the in-memory choice still applies */
  }
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

function deployedBy(d: Deployment): string {
  return (
    d.metadata?.labels?.['io.portainer.kubernetes.application.owner'] ||
    d.metadata?.labels?.['io.portainer.kubernetes.application.owner.id'] ||
    '—'
  )
}

const BADGE_LABEL_MAX = 40

/* Badges wrap onto multiple lines rather than ellipsizing at the column's
   pixel width, so a moderately long name still reads in full. Only a
   pathologically long value gets hard-cut, to keep the row from growing
   without bound. */
function truncateBadgeLabel(value: string): string {
  return value.length > BADGE_LABEL_MAX
    ? `${value.slice(0, BADGE_LABEL_MAX)}…`
    : value
}

/* Its own component rather than an inline render, because the per-row
   permission check is a hook — it needs a component that mounts once per row. */
function RowActions({
  d,
  onViewLogs,
}: {
  d: Deployment
  onViewLogs: () => void
}) {
  const token = useAppStore((s) => s.token)
  const setRestartTarget = useAppStore((s) => s.setRestartTarget)
  const envPermissions = useAppStore((s) => s.envPermissions)
  const patchEnvPermissions = useAppStore((s) => s.patchEnvPermissions)
  const permKey = `${d._envId}:${d.metadata.namespace}`
  const perms = envPermissions[permKey] ?? null

  useEffect(() => {
    if (envPermissions[permKey] !== undefined) return
    const envId = d._envId
    if (envId == null) return
    void checkEnvPermissions(token, envId, d.metadata.namespace).then(
      (p: unknown) => patchEnvPermissions(envId, d.metadata.namespace, p),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permKey])

  return (
    <div
      style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}
      onClick={(e) => e.stopPropagation()}
    >
      <Button
        variant="ghost"
        onClick={onViewLogs}
        disabled={!perms?.canViewLogs}
        disabledReason={
          !perms?.canViewLogs
            ? 'You do not have permission to view logs in this environment'
            : undefined
        }
      >
        Logs
      </Button>
      <Button
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation()
          if (!token) return
          setRestartTarget({
            envId: d._envId,
            ns: d.metadata.namespace,
            name: d.metadata.name,
          })
        }}
        disabled={!perms?.canRestart}
        disabledReason={
          !perms?.canRestart
            ? 'You do not have permission to restart workloads in this environment'
            : undefined
        }
      >
        Restart
      </Button>
    </div>
  )
}

function HealthCell({
  d,
  envStatusClientCache,
}: {
  d: Deployment
  envStatusClientCache: Record<string, unknown>
}) {
  const { tone, label } = rowStatus(d)
  const extra = getExtraForApp(envStatusClientCache, d._envId, d.metadata.name)
  return (
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
  )
}

function AccessCell({
  d,
  envStatusClientCache,
}: {
  d: Deployment
  envStatusClientCache: Record<string, unknown>
}) {
  const extra = getExtraForApp(envStatusClientCache, d._envId, d.metadata.name)
  if (extra.accessUrl) {
    return (
      <a
        href={extra.accessUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={extra.accessLabel || extra.accessUrl}
        onClick={(e) => e.stopPropagation()}
        style={{
          color: 'var(--accent, #2e90fa)',
          fontSize: 12,
          fontWeight: 600,
          textDecoration: 'none',
        }}
      >
        Launch
      </a>
    )
  }
  if (extra.accessLabel) {
    return (
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        {extra.accessLabel}
      </span>
    )
  }
  return <span style={{ color: 'var(--muted)' }}>—</span>
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
    sortDir: 'asc',
    filter: '',
    page: '1',
  })
  const listSort = listQuery.sortBy
  const sortDir = (listQuery.sortDir as SortDir) ?? 'asc'
  const search = listQuery.filter ?? ''
  const page = Number(listQuery.page) || 1

  const [listSubFilter, setListSubFilter] = useState<string | null>(null)
  const [envFilter, setEnvFilter] = useState<string | null>(null)
  const [hiddenColumns, setHiddenColumns] =
    useState<string[]>(readHiddenColumns)

  const deps = useMemo(
    () => visibleDeployments(useAppStore.getState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [environments, disabledEnvs, cache.deployments],
  )
  useEnvStatusOnDeployments(deps, token)

  const envNames = useMemo(() => {
    const names = new Set<string>()
    for (const d of deps) if (d._envName) names.add(d._envName)
    return [...names].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    )
  }, [deps])

  const sortedItems: ListItem[] = useMemo(() => {
    const base = deps.map((d: Deployment) => ({ id: serviceRowId(d), d }))
    const byName = (a: ListItem, b: ListItem) =>
      a.d.metadata.name.localeCompare(b.d.metadata.name, undefined, {
        sensitivity: 'base',
      })

    let cmp: (a: ListItem, b: ListItem) => number
    if (listSort === 'env') {
      cmp = (a, b) => {
        const ea = a.d._envName || ''
        const eb = b.d._envName || ''
        if (ea !== eb)
          return ea.localeCompare(eb, undefined, { sensitivity: 'base' })
        return byName(a, b)
      }
    } else if (listSort === 'ns') {
      cmp = (a, b) => {
        const na = a.d.metadata.namespace || ''
        const nb = b.d.metadata.namespace || ''
        if (na !== nb)
          return na.localeCompare(nb, undefined, { sensitivity: 'base' })
        return byName(a, b)
      }
    } else if (listSort === 'status') {
      const orderIdx = (x: ListItem) =>
        STATUS_SORT_ORDER.indexOf(primaryServicePartition(x.d))
      cmp = (a, b) => {
        const ia = orderIdx(a)
        const ib = orderIdx(b)
        if (ia !== ib) return ia - ib
        return byName(a, b)
      }
    } else if (listSort === 'age') {
      // Newest first at 'asc' — the column reads "Deployed", and most-recent
      // at the top is the useful default for a deploy list.
      cmp = (a, b) => {
        const at = new Date(a.d.metadata?.creationTimestamp || 0).getTime()
        const bt = new Date(b.d.metadata?.creationTimestamp || 0).getTime()
        return bt - at
      }
    } else if (listSort === 'owner') {
      cmp = (a, b) => {
        const oa = deployedBy(a.d)
        const ob = deployedBy(b.d)
        if (oa !== ob)
          return oa.localeCompare(ob, undefined, { sensitivity: 'base' })
        return byName(a, b)
      }
    } else {
      cmp = byName
    }

    const out = [...base].sort(cmp)
    return sortDir === 'desc' ? out.reverse() : out
  }, [deps, listSort, sortDir])

  /* The health sub-filter (from the summary bar) no longer depends on the
     sort. SortableList's grouped headers used to supply that context; with
     DataTable there is no grouping, so the filter has to stand on its own. */
  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sortedItems.filter((item) => {
      if (listSubFilter && primaryServicePartition(item.d) !== listSubFilter)
        return false
      if (envFilter && item.d._envName !== envFilter) return false
      if (!q) return true
      const envN = item.d._envName || ''
      const n = item.d.metadata.name
      const { label } = rowStatus(item.d)
      return `${n} ${envN} ${label}`.toLowerCase().includes(q)
    })
  }, [sortedItems, listSubFilter, envFilter, search])

  const totalPages = Math.max(1, Math.ceil(visibleItems.length / PAGE_SIZE))
  const clampedPage = Math.min(page, totalPages)
  const pageItems = useMemo(
    () =>
      visibleItems.slice(
        (clampedPage - 1) * PAGE_SIZE,
        clampedPage * PAGE_SIZE,
      ),
    [visibleItems, clampedPage],
  )

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

  function patchQuery(next: Record<string, string>) {
    setListQuery((q) => ({ ...q, ...next }))
  }

  function selectSubFilter(partition: string | null) {
    setListSubFilter(
      partition === null || listSubFilter === partition ? null : partition,
    )
    patchQuery({ page: '1' })
  }

  function applySort(key: string) {
    // The same column again flips direction; a new column starts ascending.
    patchQuery({
      sortBy: key,
      sortDir: listSort === key && sortDir === 'asc' ? 'desc' : 'asc',
      page: '1',
    })
  }

  const initialLoading =
    !cache.deployments.length && cache.fetching && !cache.everLoaded
  const showEmpty = !initialLoading && !deps.length

  const emptyMessage = listSubFilter
    ? SVC_STATUS_SUBFILTER_EMPTY[listSubFilter] ||
      'No applications match this filter.'
    : 'No applications match'

  const allColumns: ColumnDef<ListItem>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      width: '16%',
      render: ({ d }) => (
        <span
          style={{
            display: 'block',
            fontWeight: 600,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {d.metadata.name}
        </span>
      ),
    },
    {
      key: 'env',
      header: 'Environment',
      sortable: true,
      width: '14%',
      render: ({ d }) => {
        const full = d._envName || '—'
        return (
          <span title={full} style={{ display: 'block', maxWidth: '100%' }}>
            <Badge
              tone="neutral"
              size="sm"
              style={{ maxWidth: '100%', overflow: 'hidden' }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {truncateBadgeLabel(full)}
              </span>
            </Badge>
          </span>
        )
      },
    },
    {
      key: 'ns',
      header: 'Project space',
      sortable: true,
      width: '22%',
      render: ({ d }) => {
        const full = d.metadata.namespace
        return (
          <span title={full} style={{ display: 'block', maxWidth: '100%' }}>
            <Badge
              tone="neutral"
              size="sm"
              style={{ maxWidth: '100%', overflow: 'hidden' }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {truncateBadgeLabel(full)}
              </span>
            </Badge>
          </span>
        )
      },
    },
    {
      key: 'status',
      header: 'Health',
      sortable: true,
      width: '13%',
      render: ({ d }) => (
        <HealthCell d={d} envStatusClientCache={envStatusClientCache} />
      ),
    },
    {
      key: 'access',
      header: 'Access',
      width: '7%',
      render: ({ d }) => (
        <AccessCell d={d} envStatusClientCache={envStatusClientCache} />
      ),
    },
    {
      key: 'age',
      header: 'Deployed',
      sortable: true,
      width: '8%',
      render: ({ d }) => (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {age(d.metadata?.creationTimestamp)}
        </span>
      ),
    },
    {
      key: 'owner',
      header: 'Deployed by',
      sortable: true,
      width: '11%',
      render: ({ d }) => (
        <span
          title={deployedBy(d)}
          style={{
            display: 'block',
            fontSize: 12,
            color: 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {deployedBy(d)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '140px',
      render: ({ d }) => (
        <RowActions
          d={d}
          onViewLogs={() =>
            navigate(
              serviceDetailPath(
                String(d._envId),
                d.metadata.namespace,
                d.metadata.name,
                'logs',
              ),
            )
          }
        />
      ),
    },
  ]

  const columns = allColumns.filter((c) => !hiddenColumns.includes(c.key))

  const headerActions = (
    <>
      <DropdownMenu
        trigger={
          <Button variant="secondary" leftSection={<ListFilter size={14} />}>
            {envFilter ?? 'Environment'}
          </Button>
        }
      >
        <DropdownMenuItem
          label="All environments"
          icon={envFilter === null ? <Check size={14} /> : undefined}
          onClick={() => {
            setEnvFilter(null)
            patchQuery({ page: '1' })
          }}
        />
        {envNames.map((name) => (
          <DropdownMenuItem
            key={name}
            label={name}
            icon={envFilter === name ? <Check size={14} /> : undefined}
            onClick={() => {
              setEnvFilter(name)
              patchQuery({ page: '1' })
            }}
          />
        ))}
      </DropdownMenu>

      <span style={{ flex: 1 }} />

      <DropdownMenu
        align="right"
        trigger={
          <Button variant="secondary" leftSection={<Eye size={14} />}>
            View
          </Button>
        }
      >
        <DropdownMenuSection label="Columns">
          {HIDEABLE_COLUMNS.map((col) => (
            <DropdownMenuItem
              key={col.key}
              label={col.label}
              icon={
                hiddenColumns.includes(col.key) ? undefined : (
                  <Check size={14} />
                )
              }
              onClick={() => {
                // Computed outside the updater so the updater stays pure —
                // StrictMode double-invokes updaters in development.
                const next = hiddenColumns.includes(col.key)
                  ? hiddenColumns.filter((k) => k !== col.key)
                  : [...hiddenColumns, col.key]
                setHiddenColumns(next)
                writeHiddenColumns(next)
              }}
            />
          ))}
        </DropdownMenuSection>
      </DropdownMenu>

      <DropdownMenu
        align="right"
        trigger={
          <Button variant="secondary" leftSection={<ArrowUpDown size={14} />}>
            Sort
          </Button>
        }
      >
        <DropdownMenuSection label="Sort by">
          {SERVICE_LIST_SORT.map((opt) => (
            <DropdownMenuItem
              key={opt.value}
              label={opt.label}
              icon={listSort === opt.value ? <Check size={14} /> : undefined}
              onClick={() => applySort(opt.value)}
            />
          ))}
        </DropdownMenuSection>
        <DropdownMenuSection label="Direction">
          <DropdownMenuItem
            label="Ascending"
            icon={sortDir === 'asc' ? <Check size={14} /> : undefined}
            onClick={() => patchQuery({ sortDir: 'asc', page: '1' })}
          />
          <DropdownMenuItem
            label="Descending"
            icon={sortDir === 'desc' ? <Check size={14} /> : undefined}
            onClick={() => patchQuery({ sortDir: 'desc', page: '1' })}
          />
        </DropdownMenuSection>
      </DropdownMenu>
    </>
  )

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
              <Button onClick={() => navigate(ROUTES.deploy)}>+ Deploy</Button>
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
      ) : (
        <DataTableCard<ListItem>
          columns={columns}
          rows={pageItems}
          skeleton={initialLoading}
          skeletonRowCount={5}
          emptyMessage={emptyMessage}
          totalCount={visibleItems.length}
          countLabel="applications"
          page={clampedPage}
          totalPages={totalPages}
          pageSize={PAGE_SIZE}
          onPageChange={(p) => patchQuery({ page: String(p) })}
          sortKey={listSort}
          sortDir={sortDir}
          onSort={(key) => applySort(key)}
          onRowClick={({ d }) =>
            navigate(
              serviceDetailPath(
                String(d._envId),
                d.metadata.namespace,
                d.metadata.name,
                'overview',
              ),
            )
          }
          searchValue={search}
          onSearchChange={(v) => patchQuery({ filter: v, page: '1' })}
          searchPlaceholder="Filter applications…"
          // Matches the header buttons, which are Button's default 'base'.
          controlSize="base"
          actions={headerActions}
        />
      )}
    </div>
  )
}
