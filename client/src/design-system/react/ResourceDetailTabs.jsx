/**
 * React port of ResourceDetailTabs.vue
 *
 * Routable mode: pass `tabBasePath` (e.g. `/resource-detail-tabs`) together with
 * `activeTab` (from the URL) and `onTabChange` (navigate, e.g. router.push).
 * Tabs render as `<a href="...">` with click prevented so the host router can
 * update without a full reload; href still enables open-in-new-tab.
 *
 * Non-routable: omit `tabBasePath`; tabs are buttons and `onTabChange` updates parent state.
 *
 * Dropdown group: `{ id, label, icon?, dropdown: true, items: [{ id, label, icon? }], badge? }`.
 * Active tab id must match an item id (or a normal tab id). The group `id` is not a route segment.
 *
 * Slot equivalent: `actions` – React node on the right side of the tab row
 */
import { useState, useEffect, useCallback } from 'react'
import { icons } from '../icons.js'

function isDropdownTab(tab) {
  return Boolean(tab?.dropdown && Array.isArray(tab.items) && tab.items.length > 0)
}

function leafTabIds(tabs) {
  const ids = []
  for (const t of tabs) {
    if (isDropdownTab(t)) {
      for (const item of t.items) ids.push(item.id)
    } else {
      ids.push(t.id)
    }
  }
  return ids
}

function firstLeafTabId(tabs) {
  if (!tabs?.length) return ''
  const t = tabs[0]
  if (isDropdownTab(t)) return t.items[0]?.id ?? ''
  return t.id
}

function effectiveActiveTabId(tabs, activeTab) {
  const leaves = leafTabIds(tabs)
  const candidate = activeTab || firstLeafTabId(tabs)
  return leaves.includes(candidate) ? candidate : firstLeafTabId(tabs)
}

export default function ResourceDetailTabs({
  tabs = [],
  activeTab = '',
  onTabChange,
  tabBasePath,
  actions,
}) {
  const effectiveActive = effectiveActiveTabId(tabs, activeTab)
  const isRoutable = Boolean(tabBasePath && onTabChange)
  const base = tabBasePath ? tabBasePath.replace(/\/$/, '') : ''

  const [openDropdownId, setOpenDropdownId] = useState(null)

  const closeDropdown = useCallback(() => setOpenDropdownId(null), [])

  useEffect(() => {
    function onPointerDown(e) {
      if (!openDropdownId) return
      if (!e.target.closest?.('.detail-tab-dropdown')) closeDropdown()
    }
    function onKey(e) {
      if (e.key === 'Escape') closeDropdown()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [openDropdownId, closeDropdown])

  function badgeClassName(tab) {
    const t = tab.badgeType || 'default'
    const classes = ['detail-tab-badge']
    if (t === 'error') classes.push('detail-tab-badge-error')
    if (t === 'syncing') classes.push('detail-tab-badge-syncing')
    return classes.join(' ')
  }

  function tabClassName(tab) {
    return `detail-tab${effectiveActive === tab.id ? ' active' : ''}`
  }

  function dropdownGroupActive(tab) {
    if (!isDropdownTab(tab)) return false
    return tab.items.some(item => item.id === effectiveActive)
  }

  function toggleDropdown(tab) {
    setOpenDropdownId(prev => (prev === tab.id ? null : tab.id))
  }

  return (
    <div className="detail-tabs-row">
      <div className="detail-tabs">
        {tabs.map(tab => {
          if (isDropdownTab(tab)) {
            const open = openDropdownId === tab.id
            return (
              <div
                key={tab.id}
                className={`detail-tab-dropdown${open ? ' is-open' : ''}`}
                onClick={e => e.stopPropagation()}
              >
                <button
                  type="button"
                  className={`detail-tab detail-tab-dropdown-trigger${dropdownGroupActive(tab) ? ' active' : ''}`}
                  aria-expanded={open}
                  aria-haspopup="menu"
                  onClick={e => {
                    e.stopPropagation()
                    toggleDropdown(tab)
                  }}
                >
                  {tab.icon && (
                    <span
                      className="detail-tab-icon"
                      dangerouslySetInnerHTML={{ __html: tab.icon }}
                    />
                  )}
                  <span className="detail-tab-label">{tab.label}</span>
                  <span
                    className="detail-tab-dropdown-chevron"
                    dangerouslySetInnerHTML={{ __html: icons.chevronDown }}
                  />
                  {tab.badge != null && tab.badge !== '' && (
                    <span className={badgeClassName(tab)}>{tab.badge}</span>
                  )}
                </button>
                {open && (
                  <div className="detail-tab-dropdown-menu" role="menu" aria-label={tab.label}>
                    {tab.items.map(item =>
                      isRoutable ? (
                        <a
                          key={item.id}
                          href={`${base}/${item.id}`}
                          className={`detail-tab-dropdown-item${effectiveActive === item.id ? ' active' : ''}`}
                          role="menuitem"
                          onClick={e => {
                            e.preventDefault()
                            closeDropdown()
                            onTabChange(item.id)
                          }}
                        >
                          {item.icon && (
                            <span
                              className="detail-tab-dropdown-item-icon"
                              dangerouslySetInnerHTML={{ __html: item.icon }}
                            />
                          )}
                          {item.label}
                        </a>
                      ) : (
                        <button
                          key={item.id}
                          type="button"
                          className={`detail-tab-dropdown-item${effectiveActive === item.id ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            onTabChange?.(item.id)
                            closeDropdown()
                          }}
                        >
                          {item.icon && (
                            <span
                              className="detail-tab-dropdown-item-icon"
                              dangerouslySetInnerHTML={{ __html: item.icon }}
                            />
                          )}
                          {item.label}
                        </button>
                      )
                    )}
                  </div>
                )}
              </div>
            )
          }

          return isRoutable ? (
            <a
              key={tab.id}
              href={`${base}/${tab.id}`}
              className={tabClassName(tab)}
              onClick={e => {
                e.preventDefault()
                onTabChange(tab.id)
              }}
            >
              {tab.icon && (
                <span
                  className="detail-tab-icon"
                  dangerouslySetInnerHTML={{ __html: tab.icon }}
                />
              )}
              <span className="detail-tab-label">{tab.label}</span>
              {tab.badge != null && tab.badge !== '' && (
                <span className={badgeClassName(tab)}>{tab.badge}</span>
              )}
            </a>
          ) : (
            <button
              key={tab.id}
              type="button"
              className={tabClassName(tab)}
              onClick={() => onTabChange?.(tab.id)}
            >
              {tab.icon && (
                <span
                  className="detail-tab-icon"
                  dangerouslySetInnerHTML={{ __html: tab.icon }}
                />
              )}
              <span className="detail-tab-label">{tab.label}</span>
              {tab.badge != null && tab.badge !== '' && (
                <span className={badgeClassName(tab)}>{tab.badge}</span>
              )}
            </button>
          )
        })}
      </div>
      {actions && <div className="detail-tabs-actions">{actions}</div>}
    </div>
  )
}
