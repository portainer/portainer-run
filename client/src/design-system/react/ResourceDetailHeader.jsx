const LEGACY_STATUS_LABELS = {
  running: 'Running',
  error: 'Error',
  partial: 'Degraded',
  pending: 'Starting',
  stopped: 'Stopped',
}
const LEGACY_STATUS_CLASSES = {
  running: 'status-running',
  error: 'status-error',
  partial: 'status-partial',
  pending: 'status-pending',
  stopped: 'status-stopped',
}
const STATUS_COLOR_CLASSES = {
  success: 'status-running',
  danger: 'status-error',
  warning: 'status-partial',
  pending: 'status-pending',
  muted: 'status-stopped',
}

function getBadgeLabel(status, statusLabel) {
  if (statusLabel) return statusLabel
  if (status) return LEGACY_STATUS_LABELS[status] || 'Stopped'
  return ''
}

function getBadgeColorClass(status, statusColor) {
  if (status) return LEGACY_STATUS_CLASSES[status] || 'status-stopped'
  return STATUS_COLOR_CLASSES[statusColor] || 'status-stopped'
}

function getMetaItemText(item) {
  return typeof item === 'string' ? item : item?.text ?? ''
}

function getMetaItemIcon(item) {
  return typeof item === 'object' && item?.icon ? item.icon : ''
}

function getMetaItemClass(item) {
  return typeof item === 'object' && item?.class ? item.class : ''
}

/**
 * React port of ResourceDetailHeader.vue
 *
 * Slot equivalents (React nodes; when set, replace the default prop-driven UI):
 *   iconSlot, statusSlot, subtitleSlot, rightSlot
 *   actionBar – bottom action bar segment
 */
export default function ResourceDetailHeader({
  resourceTypeLabel,
  title,
  statusLabel = '',
  statusColor = 'muted',
  status = '',
  icon = '',
  metaItems = [],
  statBlocks = [],
  iconSlot,
  statusSlot,
  subtitleSlot,
  rightSlot,
  actionBar,
}) {
  const badgeLabel = getBadgeLabel(status, statusLabel)
  const badgeColorClass = getBadgeColorClass(status, statusColor)

  const showIconColumn = Boolean(iconSlot || icon)
  const showRightColumn = Boolean(rightSlot || statBlocks.length > 0)

  return (
    <div className="resource-detail-header-wrap">
      <div className="detail-header">
        <div className="detail-header-left">
          {showIconColumn && (
            <div className="header-icon-slot">
              {iconSlot ?? (
                icon ? (
                  <div className="header-icon">
                    <span className="header-icon-inner" dangerouslySetInnerHTML={{ __html: icon }} />
                  </div>
                ) : null
              )}
            </div>
          )}
          <div className="header-info">
            <span className="resource-type-label">{resourceTypeLabel}</span>
            <div className="header-title-row">
              <h1 className="header-name">{title}</h1>
              {statusSlot ?? (
                badgeLabel ? (
                  <span className={`status-badge ${badgeColorClass}`}>{badgeLabel}</span>
                ) : null
              )}
            </div>
            {subtitleSlot ? <div className="header-subtitle">{subtitleSlot}</div> : null}
            {metaItems.length > 0 && (
              <div className="header-meta">
                {metaItems.map((item, i) => (
                  <span key={i} className={`meta-item ${getMetaItemClass(item)}`.trim()}>
                    {getMetaItemIcon(item) && (
                      <span className="meta-item-icon" dangerouslySetInnerHTML={{ __html: getMetaItemIcon(item) }} />
                    )}
                    {getMetaItemText(item)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {showRightColumn && (
          <div className="detail-header-right">
            {rightSlot ?? (
              <div className="header-stats">
                {statBlocks.map((block, i) => {
                  const dotClass = block.withDot && block.status
                    ? `stat-block-with-dot stat-block-${block.status}`
                    : ''
                  const statusClass = !block.withDot && block.status ? block.status : ''
                  const centeredClass = !block.withDot && !block.meta ? 'stat-value-row-centered' : ''
                  const dotRowClass = block.withDot ? 'stat-value-row-with-dot' : ''

                  return (
                    <div key={i} className={`stat-block ${dotClass} ${statusClass}`.trim()}>
                      <div className="stat-header">
                        {block.icon && (
                          <span className="stat-icon" dangerouslySetInnerHTML={{ __html: block.icon }} />
                        )}
                        <span className="stat-label">{block.label}</span>
                      </div>
                      <div className={`stat-value-row ${centeredClass} ${dotRowClass}`.trim()}>
                        {block.withDot && (
                          <span className={`stat-health-dot ${block.dotStatus || block.status || 'synced'}`} />
                        )}
                        <span className="stat-value">{block.value}</span>
                        {block.valueSuffix && (
                          <span className="stat-value-suffix">{block.valueSuffix}</span>
                        )}
                      </div>
                      {block.meta && <div className="stat-meta">{block.meta}</div>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {actionBar && (
        <div className="header-action-bar-segment">
          {actionBar}
        </div>
      )}
    </div>
  )
}
