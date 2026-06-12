import { useMemo, useState } from 'react'
import SortableList from '../design-system/react/SortableList.jsx'
import StatusSummaryBar from '../design-system/react/StatusSummaryBar.jsx'
import { useAppStore, visibleEnvironments, visibleDeployments } from '../store/useAppStore.js'
import { manualRefresh } from '../services/refreshDeployments.js'

const ENV_LIST_SORT = [
  { value: 'name', label: 'Name' },
  { value: 'status', label: 'Status' },
]

/**
 * One partition for ordering / default grouping (worst wins).
 * Used when not narrowed by a status sub-filter.
 */
function primaryStatusPartition(row) {
  if (row.unavailable > 0) return 'workloads_down'
  if (row.degraded > 0) return 'workloads_degraded'
  if (row.running > 0) return 'workloads_running'
  return 'no_workloads'
}

const STATUS_GROUP_INFO = {
  workloads_down: { name: 'Has down workloads', description: '', icon: null },
  workloads_degraded: { name: 'Has degraded workloads', description: '', icon: null },
  workloads_running: { name: 'Has running workloads', description: '', icon: null },
  no_workloads: { name: 'No active workloads', description: '', icon: null },
}

const STATUS_SUBFILTER_EMPTY = {
  workloads_down: 'No environments with unavailable applications.',
  workloads_degraded: 'No environments with degraded applications.',
  workloads_running: 'No environments with running applications.',
  no_workloads: 'No environments with only idle or no active workloads in this view.',
}

/** Unfiltered section / sort order: severity first */
const STATUS_SORT_ORDER = [
  'workloads_down',
  'workloads_degraded',
  'workloads_running',
  'no_workloads',
]

/**
 * Keys used for the Status sub-filter checkboxes. Overlaps allowed.
 * `no_workloads` must be included when none of the “Has *” conditions apply, or SortableList
 * drops every option (count 0) and the dropdown is empty below “All”.
 */
function statusSubFilterKeysForItem(row) {
  const k = []
  if (row.unavailable > 0) k.push('workloads_down')
  if (row.degraded > 0) k.push('workloads_degraded')
  if (row.running > 0) k.push('workloads_running')
  if (k.length === 0) k.push('no_workloads')
  return k
}

function cacheStatusDotClass(status) {
  if (status === 'loading') return 'cache-dot loading'
  if (status === 'cached') return 'cache-dot stale'
  if (status === 'fresh') return 'cache-dot fresh'
  return 'cache-dot stale'
}

/** One line for the header; clarifies live fetch vs session cache. */
function cacheStatusShortText(cache, cacheStatus) {
  if (cacheStatus === 'loading') {
    if (cache?.everLoaded) return 'Refreshing…'
    return 'Loading…'
  }
  if (cacheStatus === 'cached') return 'Showing cache — live load…'
  if (cacheStatus === 'fresh') {
    if (cache?.lastFetch) {
      const s = Math.round((Date.now() - cache.lastFetch) / 1000)
      if (s < 5) return 'Up to date'
    }
    return 'Up to date'
  }
  if (cacheStatus === 'stale') return 'Live refresh failed'
  return '—'
}

export function DashboardPage() {
  const cache = useAppStore((s) => s.cache)
  const cacheStatus = useAppStore((s) => s.cacheStatus)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const isAdmin = useAppStore((s) => s.isAdmin)

  const [envListSort, setEnvListSort] = useState('name')
  const [envListSubFilter, setEnvListSubFilter] = useState(/** @type {string | null} */ (null))

  const vis = useMemo(
    () => visibleEnvironments({ environments, disabledEnvs }),
    [environments, disabledEnvs],
  )

  const visibleDeps = useMemo(
    () => visibleDeployments(useAppStore.getState()),
    [environments, disabledEnvs, cache.deployments],
  )

  const byEnv = useMemo(() => {
    const m = {}
    for (const e of vis) {
      m[e.Id] = {
        id: String(e.Id),
        envId: e.Id,
        name: e.Name,
        total: 0,
        running: 0,
        degraded: 0,
        unavailable: 0,
        scaledDown: 0,
      }
    }
    for (const d of visibleDeps) {
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
  }, [visibleDeps, vis])

  const listItems = useMemo(() => {
    const withMeta = byEnv.map((r) => ({ ...r }))
    if (envListSort === 'name') {
      return [...withMeta].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    }
    if (envListSort === 'status') {
      const orderIdx = (r) => STATUS_SORT_ORDER.indexOf(primaryStatusPartition(r))
      return [...withMeta].sort((a, b) => {
        const ia = orderIdx(a)
        const ib = orderIdx(b)
        if (ia !== ib) return ia - ib
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
    }
    return withMeta
  }, [byEnv, envListSort])

  const summary = useMemo(() => {
    const deps = visibleDeps
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
  }, [visibleDeps])

  const hiddenCount = environments.length - vis.length

  /** Drives which summary segment is highlighted; mirrors SortableList sub-filter (deployment-level). */
  const activeSummarySegmentId = useMemo(() => {
    switch (envListSubFilter) {
      case 'workloads_running':
        return 'r'
      case 'workloads_degraded':
        return 'd'
      case 'workloads_down':
        return 'u'
      default:
        return null
    }
  }, [envListSubFilter])

  const onSummarySegmentSelect = (segmentId) => {
    if (segmentId == null) {
      setEnvListSubFilter(null)
      return
    }
    setEnvListSort('status')
    if (segmentId === 'r') setEnvListSubFilter('workloads_running')
    else if (segmentId === 'd') setEnvListSubFilter('workloads_degraded')
    else if (segmentId === 'u') setEnvListSubFilter('workloads_down')
  }

  const initialLoading = !cache.deployments.length && cache.fetching && !cache.everLoaded

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-sub">Overview of all environments and workload health</div>
        </div>
        <div className="page-header-aside">
          <div
            className="cache-header-status"
            title={cacheStatus === 'cached' ? 'Data was restored from your last session; fetching live data from the cluster' : undefined}
          >
            <div className={cacheStatusDotClass(cacheStatus)} aria-hidden />
            <span className="cache-header-label">{cacheStatusShortText(cache, cacheStatus)}</span>
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
          activeSegmentId={activeSummarySegmentId}
          onSelect={onSummarySegmentSelect}
          segments={[
            { id: 't', type: 'total', value: String(summary.total), label: 'Total applications' },
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

      {initialLoading ? (
        <div className="sortable-list-container env-list-outer" aria-busy>
          <div className="sl-sortable-list">
            <div className="list-group">
              <div className="list-column-headers">
                <div className="env-list-header">
                  <div className="env-list-h-name">Environment</div>
                  {['Total', 'Running', 'Degraded', 'Down'].map((h) => (
                    <div key={h} className="env-list-h-metric">
                      {h}
                    </div>
                  ))}
                </div>
              </div>
              <div className="list-group-items">
                {vis.map((e) => (
                  <div key={e.Id} className="env-list-row env-list-row--skeleton">
                    <div className="env-list-col-name">{e.Name}</div>
                    <div className="env-list-metric">—</div>
                    <div className="env-list-metric">—</div>
                    <div className="env-list-metric">—</div>
                    <div className="env-list-metric">—</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="dashboard-env-list">
          <SortableList
            items={listItems}
            sort={envListSort}
            onSortChange={setEnvListSort}
            subFilter={envListSubFilter}
            onSubFilterChange={setEnvListSubFilter}
            sortOptions={ENV_LIST_SORT}
            defaultSort="name"
            searchPlaceholder="Filter environments…"
            emptyMessage="No environments to show"
            noResultsMessage="No environments match"
            includeZeroCountSubFilters
            getSubFilterEmptyMessage={(key) => STATUS_SUBFILTER_EMPTY[key] || 'No environments match this filter.'}
            getItemGroup={(item, sortBy) => (sortBy === 'status' ? primaryStatusPartition(item) : null)}
            getGroupInfo={(key) => STATUS_GROUP_INFO[key] || { name: String(key), description: '', icon: null }}
            getGroupOrder={(sortBy) => (sortBy === 'status' ? STATUS_SORT_ORDER : null)}
            getItemFilterGroups={(item, sortBy) => {
              if (sortBy !== 'status') return []
              return statusSubFilterKeysForItem(item)
            }}
            filterItem={(item, q) => item.name.toLowerCase().includes(q)}
            renderColumnHeaders={() => (
              <div className="env-list-header">
                <div className="env-list-h-name">Environment</div>
                {['Total', 'Running', 'Degraded', 'Down'].map((h) => (
                  <div key={h} className="env-list-h-metric">
                    {h}
                  </div>
                ))}
              </div>
            )}
            renderItem={(row) => (
              <div className="env-list-row">
                <div className="env-list-col-name">{row.name}</div>
                <div className="env-list-metric" data-label="TOTAL">{row.total}</div>
                <div className="env-list-metric env-list-metric--run" data-label="RUN">{row.running}</div>
                <div className="env-list-metric env-list-metric--deg" data-label="DEG">{row.degraded}</div>
                <div className="env-list-metric env-list-metric--down" data-label="DOWN">{row.unavailable}</div>
              </div>
            )}
          />
        </div>
      )}
    </div>
  )
}
