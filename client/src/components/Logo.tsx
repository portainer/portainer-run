// Sidebar logo slots — Portainer wordmark plus the RUN product badge.

function RunBadge({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const square = size === 'md' ? 10 : 8
  const font = size === 'md' ? 11 : 9
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span
        style={{
          width: square,
          height: square,
          borderRadius: 2,
          background: 'var(--brand, #0ea5e9)',
          display: 'inline-block',
        }}
      />
      <span
        style={{
          fontWeight: 700,
          fontSize: font,
          letterSpacing: '0.18em',
          color: 'var(--text, #111827)',
        }}
      >
        RUN
      </span>
    </span>
  )
}

export function SidebarLogo() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
      }}
      title="Portainer-Run — Dashboard"
    >
      <img
        src={`${import.meta.env.BASE_URL}portainer-logo.png`}
        alt="Portainer"
        style={{ height: 20, width: 'auto', display: 'block' }}
      />
      <RunBadge />
    </div>
  )
}

export function SidebarLogoCollapsed() {
  return <RunBadge size="sm" />
}
