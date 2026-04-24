export function PlaceholderPage({ title, children }) {
  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">{title}</div>
          <div className="page-sub">This area is part of the React migration.</div>
        </div>
      </div>
      <div className="deploy-form" style={{ color: 'var(--text-dim)' }}>
        {children}
      </div>
    </div>
  )
}
