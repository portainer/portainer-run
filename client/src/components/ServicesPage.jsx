import { useCallback, useEffect, useMemo, useState } from 'react'
import { checkEnvPermissions } from '../lib/envPermissions.js'
import { restartDeployment } from '../lib/restartDeployment.js'
import { useNavigate } from 'react-router-dom'
import SortableList from '../design-system/react/SortableList.jsx'
import StatusSummaryBar from '../design-system/react/StatusSummaryBar.jsx'
import { useAppStore, visibleDeployments } from '../store/useAppStore.js'
import { ROUTES, serviceDetailPath } from '../lib/routes.js'
import { useEnvStatusOnDeployments, getExtraForApp } from '../hooks/useEnvStatus.js'
import { age } from '../lib/utils.js'
import { manualRefresh } from '../services/refreshDeployments.js'

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

const SVC_STATUS_GROUP = {
  workloads_down: { name: 'Unavailable', description: '', icon: null },
  workloads_degraded: { name: 'Degraded', description: '', icon: null },
  workloads_running: { name: 'Running', description: '', icon: null },
  no_workloads: { name: 'Switched off', description: '', icon: null },
}

const SVC_STATUS_SUBFILTER_EMPTY = {
  workloads_down: 'No unavailable applications in this view.',
  workloads_degraded: 'No degraded applications in this view.',
  workloads_running: 'No running applications in this view.',
  no_workloads: 'No applications are scaled to zero in this view.',
}

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

/** Aligned with dashboard service rollups: replica desired state only. */
function primaryServicePartition(d) {
  const ready = d.status?.readyReplicas || 0
  const desired = d.spec?.replicas || 0
  if (desired === 0) return 'no_workloads'
  if (ready >= desired) return 'workloads_running'
  if (ready > 0) return 'workloads_degraded'
  return 'workloads_down'
}

function cacheStatusDotClass(status) {
  if (status === 'loading') return 'cache-dot loading'
  if (status === 'cached') return 'cache-dot stale'
  if (status === 'fresh') return 'cache-dot fresh'
  return 'cache-dot stale'
}

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

function serviceRowId(d) {
  return `${d._envId}-${d.metadata.namespace}-${d.metadata.name}`
}

function ServiceRowContent({
  d,
  envStatusClientCache,
  navigate,
  setDeleteTarget,
  role = undefined,
  tabIndex = undefined,
  onClick = undefined,
  onKeyDown = undefined,
}) {
  const token = useAppStore((s) => s.token)
  const pushToast = useAppStore((s) => s.pushToast)
  const envPermissions = useAppStore((s) => s.envPermissions)
  const patchEnvPermissions = useAppStore((s) => s.patchEnvPermissions)
  const permKey = `${d._envId}:${d.metadata.namespace}`
  const perms = envPermissions[permKey] ?? null

  // Fire permission check for this row's env+namespace if not yet cached
  useEffect(() => {
    if (envPermissions[permKey] !== undefined) return
    void checkEnvPermissions(token, d._envId, d.metadata.namespace)
      .then((p) => patchEnvPermissions(d._envId, d.metadata.namespace, p))
  }, [permKey])
  const [restarting, setRestarting] = useState(false)
  const name = d.metadata.name
  const ns = d.metadata.namespace
  const envId = d._envId
  const envName = d._envName || '—'
  const images = (d.spec?.template?.spec?.containers || [])
    .map((c) => c.image)
    .filter(Boolean)
  const created = d.metadata?.creationTimestamp
  const { border, dot, label } = rowClasses(d)
  const extra = getExtraForApp(envStatusClientCache, envId, name)

  const onRestart = async (e) => {
    e.stopPropagation()
    if (!token || restarting) return
    setRestarting(true)
    try {
      await restartDeployment(token, String(envId), ns, name)
      pushToast(`"${name}" is restarting — pods will be replaced one by one`, 'ok')
      void manualRefresh(false)
    } catch (err) {
      pushToast('Restart failed: ' + (err?.message || String(err)), 'err')
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div
      role={role}
      tabIndex={tabIndex}
      className={`svc-l-row svc-row ${border}`}
      data-svc-env={String(envId)}
      data-svc-name={name}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div className="svc-name">
        <div className="svc-name-body">
        {name}
        </div>
      </div>
      <div className="svc-image" title={images.join('\n') || '—'}>
        {images.length ? (
          images.map((img, i) => (
            <div key={`${name}-img-${i}`} className="svc-image-line">{img}</div>
          ))
        ) : (
          '—'
        )}
      </div>
      <div className="svc-env" title={envName}>
        <span className="ns-badge">{envName}</span>
      </div>
      <div className="svc-ns">
        <span className="ns-badge">{ns}</span>
      </div>
      <div className="status-cell">
        <span className="status-light">
          <span className={`status-dot ${dot}`} />
          {label}
          {d.spec?.replicas > 1 && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>
              {d.status?.readyReplicas || 0}/{d.spec.replicas}
            </span>
          )}
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
          onClick={() => perms?.canViewLogs ? navigate(serviceDetailPath(String(envId), ns, name, 'logs')) : null}
          disabled={!perms?.canViewLogs}
          title={!perms?.canViewLogs ? 'You do not have permission to view logs in this environment' : undefined}
          style={!perms?.canViewLogs ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
        >
          Logs
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={onRestart}
          disabled={restarting || !perms?.canRestart}
          title={!perms?.canRestart ? 'You do not have permission to restart workloads in this environment' : undefined}
          style={!perms?.canRestart ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
        >
          {restarting ? '…' : 'Restart'}
        </button>

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
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const features = useAppStore((s) => s.features)
  const [deployMenuOpen, setDeployMenuOpen] = useState(false)

  const enabledDeployFeatures = [
    features.vibeDeploy      && { label: 'Vibe Deploy',       route: ROUTES.deployVibe },
    features.simpleDeploy    && { label: 'Simple Deploy',     route: ROUTES.deploy },
    features.manifestBuilder && { label: 'Manifest Builder',  route: ROUTES.deployManifest },
  ].filter(Boolean)

  function handleDeployClick() {
    if (enabledDeployFeatures.length === 1) {
      navigate(enabledDeployFeatures[0].route)
    } else if (enabledDeployFeatures.length > 1) {
      setDeployMenuOpen((o) => !o)
    }
  }
  const pushToast = useAppStore((s) => s.pushToast)

  const [listSort, setListSort] = useState('name')
  const [listSubFilter, setListSubFilter] = useState(/** @type {string | null} */ (null))

  const deps = useMemo(
    () => visibleDeployments(useAppStore.getState()),
    [environments, disabledEnvs, cache.deployments],
  )
  useEnvStatusOnDeployments(deps, token)

  const listItems = useMemo(() => {
    const base = deps.map((d) => ({ id: serviceRowId(d), d }))
    if (listSort === 'name') {
      return [...base].sort((a, b) =>
        a.d.metadata.name.localeCompare(b.d.metadata.name, undefined, { sensitivity: 'base' }),
      )
    }
    if (listSort === 'env') {
      return [...base].sort((a, b) => {
        const ea = a.d._envName || ''
        const eb = b.d._envName || ''
        if (ea !== eb) return ea.localeCompare(eb, undefined, { sensitivity: 'base' })
        return a.d.metadata.name.localeCompare(b.d.metadata.name, undefined, { sensitivity: 'base' })
      })
    }
    if (listSort === 'status') {
      const orderIdx = (x) => STATUS_SORT_ORDER.indexOf(primaryServicePartition(x.d))
      return [...base].sort((a, b) => {
        const ia = orderIdx(a)
        const ib = orderIdx(b)
        if (ia !== ib) return ia - ib
        return a.d.metadata.name.localeCompare(b.d.metadata.name, undefined, { sensitivity: 'base' })
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

  const summary = useMemo(() => {
    const all = deps
    const total = all.length
    let running = 0
    let degraded = 0
    let unavailable = 0
    for (const d of all) {
      const ready = d.status?.readyReplicas || 0
      const desired = d.spec?.replicas || 0
      if (desired === 0) continue
      if (ready >= desired) running++
      else if (ready > 0) degraded++
      else unavailable++
    }
    return { total, running, degraded, unavailable }
  }, [deps])

  const activeSummarySegmentId = useMemo(() => {
    switch (listSubFilter) {
      case 'workloads_running':
        return 'r'
      case 'workloads_degraded':
        return 'd'
      case 'workloads_down':
        return 'u'
      default:
        return null
    }
  }, [listSubFilter])

  const onSummarySegmentSelect = (segmentId) => {
    if (segmentId == null) {
      setListSubFilter(null)
      return
    }
    setListSort('status')
    if (segmentId === 'r') setListSubFilter('workloads_running')
    else if (segmentId === 'd') setListSubFilter('workloads_degraded')
    else if (segmentId === 'u') setListSubFilter('workloads_down')
  }

  const initialLoading = !cache.deployments.length && cache.fetching && !cache.everLoaded
  const showEmpty = !initialLoading && !deps.length

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Applications</div>
          <div className="page-sub">Kubernetes deployments managed via Portainer</div>
        </div>
        <div className="page-header-aside">
          {enabledDeployFeatures.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleDeployClick}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                + Deploy
                {enabledDeployFeatures.length > 1 && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 2 }}>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                )}
              </button>
              {deployMenuOpen && enabledDeployFeatures.length > 1 && (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                    onClick={() => setDeployMenuOpen(false)}
                  />
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
                    background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 6,
                    overflow: 'hidden', minWidth: 180, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                  }}>
                    {enabledDeployFeatures.map((f) => (
                      <button key={f.route} type="button"
                        onClick={() => { setDeployMenuOpen(false); navigate(f.route) }}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '9px 14px', fontSize: 13, fontFamily: 'var(--mono)',
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: 'var(--text)', borderBottom: '1px solid var(--border2)',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg3)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div
            className="cache-header-status"
            title={cacheStatus === 'cached' ? 'Data was restored from your last session; fetching live data from the cluster' : undefined}
          >
            <div className={cacheStatusDotClass(cacheStatus)} aria-hidden />
            <span className="cache-header-label">{cacheStatusShortText(cache, cacheStatus)}</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void manualRefresh()}>
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

      <div id="servicesContainer">
        {showEmpty ? (
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
            <p>Deploy an application to get started.</p>
          </div>
        ) : null}

        {initialLoading ? (
          <div className="sortable-list-container services-page-list" aria-busy>
            <div className="sl-sortable-list">
              <div className="list-group">
                <div className="list-column-headers">
                  <div className="svc-l-header">
                    <span className="svc-l-header-name"><span>Name</span></span>
                    <span>Image</span>
                    <span>Environment</span>
                    <span>Namespace</span>
                    <span>Status</span>
                    <span>Exposure</span>
                    <span>Age</span>
                    <span />
                  </div>
                </div>
                <div className="list-group-items">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="svc-l-row svc-skeleton-row">
                      <div className="svc-skeleton-name-cell">
                        <div className="svc-skeleton-pill" />
                      </div>
                      <div className="svc-skeleton-line" style={{ maxWidth: '100%' }} />
                      <div className="svc-skeleton-pill sm" />
                      <div className="svc-skeleton-pill" />
                      <div className="svc-skeleton-line" />
                      <div className="svc-skeleton-pill" />
                      <div className="svc-skeleton-actions" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {!initialLoading && deps.length > 0 ? (
          <div className="services-page-list">
            <SortableList
              items={listItems}
              sort={listSort}
              onSortChange={setListSort}
              subFilter={listSubFilter}
              onSubFilterChange={setListSubFilter}
              sortOptions={SERVICE_LIST_SORT}
              defaultSort="name"
              searchPlaceholder="Filter applications…"
              emptyMessage="No applications to show"
              noResultsMessage="No applications match"
              includeZeroCountSubFilters
              getSubFilterEmptyMessage={(key) => SVC_STATUS_SUBFILTER_EMPTY[key] || 'No applications match this filter.'}
              getItemGroup={({ d }, sortBy) => (sortBy === 'status' ? primaryServicePartition(d) : null)}
              getGroupInfo={(key) => SVC_STATUS_GROUP[key] || { name: String(key), description: '', icon: null }}
              getGroupOrder={(sortBy) => (sortBy === 'status' ? STATUS_SORT_ORDER : null)}
              getItemFilterGroups={({ d }, sortBy) => {
                if (sortBy !== 'status') return []
                return [primaryServicePartition(d)]
              }}
              filterItem={({ d, id }, q) => {
                const im = d.spec?.template?.spec?.containers?.[0]?.image || ''
                const envN = d._envName || ''
                const n = d.metadata.name
                const { label } = rowClasses(d)
                const hay = `${n} ${im} ${envN} ${label}`.toLowerCase()
                return hay.includes(q)
              }}
              renderColumnHeaders={() => (
                <div className="svc-l-header">
                  <span className="svc-l-header-name"><span>Name</span></span>
                  <span>Image</span>
                  <span>Environment</span>
                  <span>Namespace</span>
                  <span>Status</span>
                  <span>Exposure</span>
                  <span>Age</span>
                  <span />
                </div>
              )}
              renderItem={(item) => {
                return (
                <ServiceRowContent
                  d={item.d}
                  envStatusClientCache={envStatusClientCache}
                  navigate={navigate}
                  setDeleteTarget={setDeleteTarget}
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    navigate(
                      serviceDetailPath(
                        String(item.d._envId),
                        item.d.metadata.namespace,
                        item.d.metadata.name,
                        'overview',
                      ),
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      navigate(
                        serviceDetailPath(
                          String(item.d._envId),
                          item.d.metadata.namespace,
                          item.d.metadata.name,
                          'overview',
                        ),
                      )
                    }
                  }}
                />
                )
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
