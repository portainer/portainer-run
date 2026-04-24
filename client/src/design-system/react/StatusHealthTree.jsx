import '../styles/StatusHealthTree.css'

const STATUS_ALIASES = {
  healthy: 'running',
  degraded: 'partial',
  syncing: 'pending',
  up: 'running',
  down: 'error',
}

const DEFAULT_DIMMED_STATUSES = ['exited']

function normalizeStatus(raw) {
  if (raw == null || raw === '') return 'stopped'
  const key = String(raw).toLowerCase().replace(/\s+/g, '_')
  return STATUS_ALIASES[key] || key
}

function indicatorClass(status, explicitClass) {
  if (explicitClass) return explicitClass
  const s = normalizeStatus(status)
  return `status-indicator status-${s}`
}

function labelCellValue(item, col, colIndex) {
  const raw = item.labels?.[col.id]
  if (raw != null && String(raw).trim() !== '') return String(raw)
  if (colIndex === 0 && item.label != null && String(item.label).trim() !== '') return String(item.label)
  return ''
}

function contributorRowClassName(item, index, contributorsLength, dimmedStatuses) {
  const last = index === contributorsLength - 1
  const dimList = dimmedStatuses.map((x) => String(x).toLowerCase())
  const dim =
    item.dimmed === true ||
    (item.dimmed !== false && dimList.includes(normalizeStatus(item.status)))
  return ['sht-branch-row', last ? 'sht-branch-last' : '', dim ? 'sht-branch-dimmed' : '']
    .filter(Boolean)
    .join(' ')
}

/**
 * Aggregate health dot + optional contributor rows (React). Parity with vue/StatusHealthTree.vue.
 *
 * Slots (Vue) → React:
 * - #root → `children`
 * - #contributor → `renderContributor({ item, index })`
 * - #contributorCell → `renderContributorCell({ item, index, column, columnIndex, value })`
 */
export default function StatusHealthTree({
  rootStatus = 'stopped',
  rootTitle = '',
  contributors = [],
  labelColumns = [],
  dense = false,
  treeMarginInlineStart = '',
  dimmedStatuses,
  children,
  renderContributor,
  renderContributorCell,
}) {
  const effectiveDimmedStatuses =
    dimmedStatuses == null || !Array.isArray(dimmedStatuses) ? DEFAULT_DIMMED_STATUSES : dimmedStatuses
  const hasLabelColumns = Array.isArray(labelColumns) && labelColumns.length > 0
  const rootDotClass = indicatorClass(rootStatus, null)
  const treeWrapStyle =
    treeMarginInlineStart !== '' && treeMarginInlineStart != null
      ? { '--sht-tree-margin-inline-start': treeMarginInlineStart }
      : undefined

  return (
    <div className={['status-health-tree', dense ? 'sht-dense' : ''].filter(Boolean).join(' ')}>
      <div className="sht-root-row">
        <div className="sht-root-dot-col">
          <span className={rootDotClass} title={rootTitle || undefined} />
        </div>
        <div className="sht-root-main">{children}</div>
      </div>

      {contributors.length > 0 ? (
        <div className="sht-tree-wrap" style={treeWrapStyle}>
          <table
            className={['sht-table', hasLabelColumns ? 'sht-table-labeled' : ''].filter(Boolean).join(' ')}
            role="presentation"
          >
            <tbody>
              {contributors.map((item, index) => (
                <tr
                  key={item.id != null ? item.id : index}
                  className={contributorRowClassName(item, index, contributors.length, effectiveDimmedStatuses)}
                >
                  <td className="sht-cell sht-branch-line" aria-hidden="true" />
                  <td className="sht-cell sht-dot-col">
                    <span
                      className={[item.statusClass || indicatorClass(item.status, null), 'sht-child-dot']
                        .filter(Boolean)
                        .join(' ')}
                      title={item.title || undefined}
                    />
                  </td>
                  {hasLabelColumns
                    ? labelColumns.map((col, colIndex) => {
                        const value = labelCellValue(item, col, colIndex)
                        const cellProps = { item, index, column: col, columnIndex: colIndex, value }
                        return (
                          <td
                            key={col.id}
                            className="sht-cell sht-label-col"
                            style={col.minWidth ? { minWidth: col.minWidth } : undefined}
                          >
                            {renderContributorCell ? (
                              renderContributorCell(cellProps)
                            ) : (
                              <span
                                className={['sht-label-text', col.monospace ? 'sht-label-text-mono' : '']
                                  .filter(Boolean)
                                  .join(' ')}
                              >
                                {value}
                              </span>
                            )}
                          </td>
                        )
                      })
                    : null}
                  {!hasLabelColumns ? (
                    <td className="sht-cell sht-body-col">
                      {renderContributor ? (
                        renderContributor({ item, index })
                      ) : item.label != null && item.label !== '' ? (
                        <span className="sht-default-label">{item.label}</span>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
