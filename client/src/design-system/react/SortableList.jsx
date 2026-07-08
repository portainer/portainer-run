import { Fragment, useState, useMemo, useEffect, useRef } from 'react'
import { icons } from '../icons.js'

export default function SortableList({
  items = [],
  sortOptions = [],
  defaultSort = null,
  searchPlaceholder = 'Filter items...',
  emptyMessage = 'No items found',
  noResultsMessage = 'No items match your search',
  getItemGroup,
  getGroupInfo,
  getGroupOrder,
  filterItem = null,
  getItemFilterGroups = null,
  /** When true, sub-filter dropdowns list every group (count may be 0). Default hides zero-count options. */
  includeZeroCountSubFilters = false,
  /** Shown when items exist but the active sub-filter (and no search) matches nothing. */
  getSubFilterEmptyMessage = null,
  showSingleGroupHeader = false,
  pageSize = 0,
  renderItem,
  renderColumnHeaders = null,
  // Controlled sort / sub-filter (mirrors Vue v-model:sort + v-model:subFilter)
  sort: sortProp = undefined,
  subFilter: subFilterProp = undefined,
  onSortChange = null,
  onSubFilterChange = null,
  /** Called when the user changes sort, sub-filter, or search (decouple summary bar, analytics, etc.). */
  onToolbarInteraction = null,
  // URL sync — provided by a Vue host via router bridge (optional)
  routeQuery = null,
  onRouteChange = null,
}) {
  const sortControlled = onSortChange != null
  const subFilterControlled = onSubFilterChange != null

  const [sortByInternal, setSortByInternal] = useState(() => {
    if (routeQuery) {
      const valid = sortOptions.map(o => o.value)
      if (routeQuery.groupBy && valid.includes(routeQuery.groupBy)) return routeQuery.groupBy
    }
    if (sortControlled && sortProp !== undefined && sortProp !== null) return sortProp
    return defaultSort || sortOptions[0]?.value
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSubFilterInternal, setActiveSubFilterInternal] = useState(() => {
    if (routeQuery?.filter) return routeQuery.filter
    if (subFilterControlled && subFilterProp !== undefined) return subFilterProp
    return null
  })

  const sortFallback = defaultSort || sortOptions[0]?.value
  const sortBy = sortControlled ? (sortProp ?? sortFallback) : sortByInternal
  const activeSubFilter = subFilterControlled ? (subFilterProp ?? null) : activeSubFilterInternal

  function commitSort(next) {
    if (sortControlled) onSortChange(next)
    else setSortByInternal(next)
  }
  function commitSubFilter(next) {
    if (subFilterControlled) onSubFilterChange(next)
    else setActiveSubFilterInternal(next)
  }
  const [currentPage, setCurrentPage] = useState(() => {
    const p = parseInt(routeQuery?.page, 10)
    return p >= 1 && Number.isFinite(p) ? p : 1
  })
  const [openDropdown, setOpenDropdown] = useState(null)
  const dropdownRef = useRef(null)

  function notifyToolbarInteraction(sortVal, subVal, searchVal) {
    onToolbarInteraction?.({
      sort: sortVal,
      subFilter: subVal,
      searchQuery: searchVal,
    })
  }

  // Keep a stable ref to onRouteChange so effects don't re-run when the function identity changes
  const onRouteChangeRef = useRef(onRouteChange)
  useEffect(() => { onRouteChangeRef.current = onRouteChange }, [onRouteChange])

  // Flags used to distinguish URL-driven state changes from user-driven ones
  const urlSyncRef = useRef(false)
  const isMountedRef = useRef(false)

  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpenDropdown(null)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

  // URL → state: sync when the host updates routeQuery (e.g. browser back/forward)
  useEffect(() => {
    if (!routeQuery) return
    urlSyncRef.current = true
    const valid = sortOptions.map(o => o.value)
    const urlSort = routeQuery.groupBy
    const nextSort = urlSort && valid.includes(urlSort) ? urlSort : (defaultSort || sortOptions[0]?.value)
    commitSort(nextSort)
    commitSubFilter(routeQuery.filter || null)
    const p = parseInt(routeQuery.page, 10)
    setCurrentPage(p >= 1 && Number.isFinite(p) ? p : 1)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeQuery?.groupBy, routeQuery?.filter, routeQuery?.page])

  // State → URL: notify host when the user changes sort / filter / page
  useEffect(() => {
    if (!isMountedRef.current) {
      isMountedRef.current = true
      return
    }
    if (urlSyncRef.current) {
      urlSyncRef.current = false
      return
    }
    if (!onRouteChangeRef.current) return
    const defaultSortVal = defaultSort || sortOptions[0]?.value
    const params = {}
    if (sortBy !== defaultSortVal) params.groupBy = sortBy
    if (activeSubFilter) params.filter = activeSubFilter
    if (pageSize > 0 && currentPage > 1) params.page = String(currentPage)
    onRouteChangeRef.current(params)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortBy, activeSubFilter, currentPage])

  // Reset page when filters change
  useEffect(() => { setCurrentPage(1) }, [searchQuery, activeSubFilter, sortBy, pageSize])

  const filteredItems = useMemo(() => {
    let result = items

    if (activeSubFilter) {
      if (getItemFilterGroups) {
        result = result.filter(item => getItemFilterGroups(item, sortBy).includes(activeSubFilter))
      } else {
        result = result.filter(item => getItemGroup(item, sortBy) === activeSubFilter)
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      if (filterItem) {
        result = result.filter(item => filterItem(item, q))
      } else {
        result = result.filter(item =>
          Object.values(item).some(val => typeof val === 'string' && val.toLowerCase().includes(q))
        )
      }
    }

    return result
  }, [items, activeSubFilter, searchQuery, sortBy, getItemGroup, getItemFilterGroups, filterItem])

  const isPaginated = pageSize > 0

  const groupSortedItems = useMemo(() => {
    const order = getGroupOrder(sortBy)
    if (!order) return filteredItems
    const groupIndex = {}
    order.forEach((g, i) => { groupIndex[g] = i })
    return [...filteredItems].sort((a, b) => {
      const ia = groupIndex[getItemGroup(a, sortBy)] ?? 999
      const ib = groupIndex[getItemGroup(b, sortBy)] ?? 999
      return ia - ib
    })
  }, [filteredItems, sortBy, getGroupOrder, getItemGroup])

  const totalPages = useMemo(() =>
    isPaginated ? Math.max(1, Math.ceil(filteredItems.length / pageSize)) : 1,
    [filteredItems.length, pageSize, isPaginated]
  )

  const safeCurrentPage = Math.min(currentPage, totalPages)

  const paginatedItems = useMemo(() => {
    if (!isPaginated) return groupSortedItems
    const start = (safeCurrentPage - 1) * pageSize
    return groupSortedItems.slice(start, start + pageSize)
  }, [groupSortedItems, isPaginated, safeCurrentPage, pageSize])

  const pagerStart = (safeCurrentPage - 1) * pageSize + 1
  const pagerEnd = Math.min(safeCurrentPage * pageSize, filteredItems.length)

  const pageNumbers = useMemo(() => {
    const t = totalPages
    if (t <= 7) return Array.from({ length: t }, (_, i) => i + 1)
    const c = safeCurrentPage
    const pages = [1]
    if (c > 3) pages.push('...')
    for (let i = Math.max(2, c - 1); i <= Math.min(t - 1, c + 1); i++) pages.push(i)
    if (c < t - 2) pages.push('...')
    pages.push(t)
    return pages
  }, [totalPages, safeCurrentPage])

  const groupOrder = useMemo(() => {
    if (activeSubFilter) return [activeSubFilter]
    return getGroupOrder(sortBy)
  }, [activeSubFilter, sortBy, getGroupOrder])

  const groupedItems = useMemo(() => {
    const order = groupOrder
    const its = paginatedItems

    if (!order) return { __all__: [...its] }

    const groups = {}
    order.forEach(g => { groups[g] = [] })
    its.forEach(item => {
      const key = getItemGroup(item, sortBy)
      if (groups[key]) groups[key].push(item)
      else if (order.length > 0) groups[order[0]].push(item)
    })
    return groups
  }, [groupOrder, paginatedItems, sortBy, getItemGroup])

  const nonEmptyGroups = useMemo(() => {
    const order = groupOrder
    if (!order) return ['__all__']
    return order.filter(g => groupedItems[g]?.length > 0)
  }, [groupOrder, groupedItems])

  function shouldShowHeader(groupKey) {
    if (groupKey === '__all__') return showSingleGroupHeader
    if (activeSubFilter) return false
    return true
  }

  function getGroupDisplayInfo(groupKey) {
    if (groupKey === '__all__') return { name: 'All Items', description: '', icon: null }
    return getGroupInfo(groupKey, sortBy)
  }

  function getFiltersForSort(sortValue) {
    const order = getGroupOrder(sortValue)
    if (!order || order.length <= 1) return []
    return order
      .map((groupKey) => {
        const info = getGroupInfo(groupKey, sortValue)
        const count = getItemFilterGroups
          ? items.filter((item) => getItemFilterGroups(item, sortValue).includes(groupKey)).length
          : items.filter((item) => getItemGroup(item, sortValue) === groupKey).length
        return { key: groupKey, label: info.name, icon: info.icon, count }
      })
      .filter((opt) => includeZeroCountSubFilters || opt.count > 0)
  }

  function sortHasFilters(sortValue) {
    const order = getGroupOrder(sortValue)
    return order && order.length > 1
  }

  const subFilterOptions = useMemo(() => {
    const order = getGroupOrder(sortBy)
    if (!order) return []
    return order
      .map((groupKey) => {
        const info = getGroupInfo(groupKey, sortBy)
        const count = getItemFilterGroups
          ? items.filter((item) => getItemFilterGroups(item, sortBy).includes(groupKey)).length
          : items.filter((item) => getItemGroup(item, sortBy) === groupKey).length
        return { key: groupKey, label: info.name, icon: info.icon, count }
      })
      .filter((opt) => includeZeroCountSubFilters || opt.count > 0)
  }, [sortBy, items, getGroupOrder, getGroupInfo, getItemGroup, getItemFilterGroups, includeZeroCountSubFilters])

  function handleSortClick(e, option) {
    e.stopPropagation()
    const hasFilters = sortHasFilters(option.value)
    if (sortBy === option.value && hasFilters) {
      setOpenDropdown(prev => prev === option.value ? null : option.value)
    } else {
      const nextSort = option.value
      commitSort(nextSort)
      commitSubFilter(null)
      notifyToolbarInteraction(nextSort, null, searchQuery)
      setOpenDropdown(hasFilters ? option.value : null)
    }
  }

  function selectFilter(filterKey) {
    const nextSub = filterKey
    commitSubFilter(nextSub)
    setOpenDropdown(null)
    notifyToolbarInteraction(sortBy, nextSub, searchQuery)
  }

  function clearSubFilter() {
    commitSubFilter(null)
    notifyToolbarInteraction(sortBy, null, searchQuery)
  }

  return (
    <div className="sortable-list-container">
      {/* Sort / filter bar */}
      <div className="sort-toggle-bar">
        <span className="sort-toggle-label">Sort by:</span>
        <div className="sort-toggle-options" ref={dropdownRef}>
          {sortOptions.map(option => {
            const hasActiveFilter = sortBy === option.value && activeSubFilter
            const filters = getFiltersForSort(option.value)
            const hasFilter = sortHasFilters(option.value)
            const isOpen = openDropdown === option.value

            return (
              <div key={option.value} className="sort-toggle-wrapper">
                <button
                  className={[
                    'sort-toggle-btn',
                    sortBy === option.value ? 'active' : '',
                    hasFilter ? 'has-filter' : '',
                    isOpen ? 'dropdown-open' : '',
                    hasActiveFilter ? 'has-active-filter' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={e => handleSortClick(e, option)}
                >
                  {option.icon && <span dangerouslySetInnerHTML={{ __html: option.icon }} />}
                  {option.label}
                  {hasActiveFilter && (
                    <span className="active-filter-badge">
                      {subFilterOptions.find(o => o.key === activeSubFilter)?.label}
                    </span>
                  )}
                  {hasFilter && (
                    <span
                      className={`dropdown-chevron${isOpen ? ' open' : ''}`}
                      dangerouslySetInnerHTML={{ __html: icons.chevronDown }}
                    />
                  )}
                </button>

                {isOpen && hasFilter && (
                  <div className="filter-dropdown" onClick={e => e.stopPropagation()}>
                    <button
                      className={`filter-dropdown-item${sortBy === option.value && !activeSubFilter ? ' active' : ''}`}
                      onClick={() => selectFilter(null)}
                    >
                      <span className="filter-item-label">All</span>
                      <span className="filter-item-count">{items.length}</span>
                    </button>
                    <div className="filter-dropdown-divider" />
                    {filters.map(filter => (
                      <button
                        key={filter.key}
                        className={`filter-dropdown-item${sortBy === option.value && activeSubFilter === filter.key ? ' active' : ''}`}
                        onClick={() => selectFilter(filter.key)}
                      >
                        {filter.icon && (
                          <span className="filter-item-icon" dangerouslySetInnerHTML={{ __html: filter.icon }} />
                        )}
                        <span className="filter-item-label">{filter.label}</span>
                        <span className="filter-item-count">{filter.count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {activeSubFilter && !openDropdown && (
          <div className="active-filter-tag">
            <span className="active-filter-tag-label">
              {subFilterOptions.find(o => o.key === activeSubFilter)?.label}
            </span>
            <button className="active-filter-tag-clear" onClick={clearSubFilter}>
              <span dangerouslySetInnerHTML={{ __html: icons.close }} />
            </button>
          </div>
        )}

        <div className={`filter-search-box${searchQuery ? ' has-value' : ''}`}>
          <span dangerouslySetInnerHTML={{ __html: icons.searchSmall }} />
          <input
            type="text"
            value={searchQuery}
            onChange={e => {
              const next = e.target.value
              setSearchQuery(next)
              notifyToolbarInteraction(sortBy, activeSubFilter, next)
            }}
            placeholder={searchPlaceholder}
            className="filter-search-input"
          />
          {searchQuery && (
            <button
              type="button"
              className="filter-search-clear"
              onClick={() => {
                setSearchQuery('')
                notifyToolbarInteraction(sortBy, activeSubFilter, '')
              }}
              title="Clear search"
            >
              <span dangerouslySetInnerHTML={{ __html: icons.close }} />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="sl-sortable-list">
        {items.length > 0 && nonEmptyGroups.length > 0 ? (
          nonEmptyGroups.map(groupKey => (
            <div key={groupKey} className="list-group">
              {shouldShowHeader(groupKey) && (() => {
                const info = getGroupDisplayInfo(groupKey)
                return (
                  <div className="list-group-header">
                    <div className="list-group-title">
                      {info.icon && (
                        <span className="list-group-icon" dangerouslySetInnerHTML={{ __html: info.icon }} />
                      )}
                      <span className="list-group-name">{info.name}</span>
                      <span className="list-group-count">{groupedItems[groupKey].length}</span>
                    </div>
                    {info.description && (
                      <div className="list-group-desc">{info.description}</div>
                    )}
                  </div>
                )
              })()}

              {renderColumnHeaders && (
                <div className="list-column-headers">
                  {renderColumnHeaders(groupKey, groupedItems[groupKey])}
                </div>
              )}

              <div className="list-group-items">
                {groupedItems[groupKey].map((item, index) => (
                  <Fragment key={item.id ?? index}>
                    {renderItem(item, index)}
                  </Fragment>
                ))}
              </div>
            </div>
          ))
        ) : null}

        {items.length === 0 && (
          <div className="list-empty-state">
            <span dangerouslySetInnerHTML={{ __html: icons.searchLarge }} />
            <p>{emptyMessage}</p>
          </div>
        )}

        {items.length > 0 && filteredItems.length === 0 && (
          <div className="list-empty-state">
            <span dangerouslySetInnerHTML={{ __html: icons.searchLarge }} />
            <p>
              {searchQuery.trim()
                ? `${noResultsMessage} "${searchQuery}"`
                : activeSubFilter && getSubFilterEmptyMessage
                  ? getSubFilterEmptyMessage(activeSubFilter)
                  : `${noResultsMessage} "${searchQuery || activeSubFilter || ''}"`}
            </p>
          </div>
        )}
      </div>

      {/* Pagination */}
      {isPaginated && totalPages > 1 && (
        <div className="pager">
          <div className="pager-info">
            Showing <strong>{pagerStart}–{pagerEnd}</strong> of <strong>{filteredItems.length}</strong>
          </div>
          <div className="pager-controls">
            <button className="pager-btn" disabled={safeCurrentPage === 1} onClick={() => setCurrentPage(1)} title="First page">
              <span dangerouslySetInnerHTML={{ __html: icons.chevronsLeft }} />
            </button>
            <button className="pager-btn" disabled={safeCurrentPage === 1} onClick={() => setCurrentPage(p => p - 1)} title="Previous page">
              <span dangerouslySetInnerHTML={{ __html: icons.chevronLeft }} />
            </button>
            {pageNumbers.map((page, i) =>
              page === '...'
                ? <span key={`ellipsis-${i}`} className="pager-ellipsis">…</span>
                : <button key={page} className={`pager-btn pager-page${page === safeCurrentPage ? ' active' : ''}`} onClick={() => setCurrentPage(page)}>{page}</button>
            )}
            <button className="pager-btn" disabled={safeCurrentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)} title="Next page">
              <span dangerouslySetInnerHTML={{ __html: icons.chevronRightMedium }} />
            </button>
            <button className="pager-btn" disabled={safeCurrentPage === totalPages} onClick={() => setCurrentPage(totalPages)} title="Last page">
              <span dangerouslySetInnerHTML={{ __html: icons.chevronsRight }} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
