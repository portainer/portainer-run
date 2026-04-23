import { icons } from '../icons.js'

/**
 * React port of ActionBar.vue
 *
 * Named slot equivalents as props:
 *   summary  – shown when !hasSelection && !bulkActionPending
 *   actions  – shown when hasSelection && !bulkActionPending
 *   pending  – shown when bulkActionPending (falls back to spinner)
 *   right    – always rendered on the right side
 */
export default function ActionBar({
  isScrolled = false,
  hasSelection = false,
  bulkActionPending = false,
  bulkActionLabel = 'Working...',
  summary,
  actions,
  pending,
  right,
  onScrollToTop,
}) {
  function handleBarClick(e) {
    if (e.target.closest('button')) return
    onScrollToTop?.()
  }

  const barClass = [
    'env-action-bar',
    'action-bar-fixed-height',
    isScrolled ? 'is-scrolled' : '',
    hasSelection ? 'has-selection' : '',
  ].filter(Boolean).join(' ')

  let leftContent
  if (!hasSelection && !bulkActionPending) {
    leftContent = summary
  } else if (hasSelection && !bulkActionPending) {
    leftContent = actions
  } else if (bulkActionPending) {
    leftContent = pending ?? (
      <>
        <span className="action-bar-spinner" dangerouslySetInnerHTML={{ __html: icons.spinnerMedium }} />
        <span className="action-bar-pending-label">{bulkActionLabel}</span>
      </>
    )
  }

  return (
    <div className={barClass} onClick={handleBarClick}>
      <div className="action-bar-left action-bar-left-nowrap">
        {leftContent}
      </div>
      <div className="action-bar-right">
        {right}
      </div>
    </div>
  )
}
