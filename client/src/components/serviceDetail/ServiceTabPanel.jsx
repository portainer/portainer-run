/**
 * Wraps service detail tab body for a consistent surface (background, border, padding).
 */
export default function ServiceTabPanel({ children, className = '' }) {
  return <div className={`service-tab-panel ${className}`.trim()}>{children}</div>
}
