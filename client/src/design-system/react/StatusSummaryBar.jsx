import { Fragment } from 'react'
import { icons } from '../icons.js'

export default function StatusSummaryBar({
  segments = [],
  activeSegmentId = null,
  onSelect,
  trailing = null,
  /** When true, no segment appears selected and the "Showing:" chip is hidden (list decoupled from bar). */
  ambientOnly = false,
}) {
  function segmentIsActive(segment) {
    if (ambientOnly) return false
    if (segment.type === 'total') return !activeSegmentId
    return activeSegmentId === segment.id
  }

  function handleClick(segment) {
    if (segment.type === 'total') {
      onSelect?.(null)
      return
    }
    const newId = activeSegmentId === segment.id ? null : segment.id
    onSelect?.(newId)
  }

  function clearFilter() {
    onSelect?.(null)
  }

  const activeLabel = segments.find(s => s.id === activeSegmentId)?.label ?? activeSegmentId

  return (
    <div className="status-summary-card">
      {segments.map((segment) => (
        <Fragment key={segment.id}>
          {segment.showDivider && <div className="summary-divider" />}
          <div
            className={['summary-segment', segment.type, segmentIsActive(segment) ? 'active' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => handleClick(segment)}
          >
            {segment.iconHtml ? (
              <div className="segment-icon" dangerouslySetInnerHTML={{ __html: segment.iconHtml }} />
            ) : segment.type?.startsWith('status-') ? (
              <div className="segment-icon">
                <span className={`status-dot ${segment.type.replace('status-', '')}`} />
              </div>
            ) : null}
            <div className="segment-content">
              <div className="segment-value">{segment.value}</div>
              <div className="segment-label">{segment.label}</div>
            </div>
            <div className="segment-bar" />
          </div>
        </Fragment>
      ))}

      {trailing ? <div className="ssb-trailing">{trailing}</div> : null}

      {activeSegmentId && !ambientOnly ? (
        <div className="ssb-active-filter-indicator">
          <span className="ssb-filter-label">
            Showing: <strong>{activeLabel}</strong>
          </span>
          <button type="button" className="ssb-clear-filter-btn" onClick={clearFilter} title="Clear filter">
            <span dangerouslySetInnerHTML={{ __html: icons.close }} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
