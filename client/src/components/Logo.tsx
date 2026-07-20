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

// The wordmark is a transparent alpha mask (white text on transparent). Painting
// it with the current text color keeps the background transparent and lets the
// foreground follow the theme — dark in light mode, light in dark mode.
const WORDMARK_ASPECT = 2129 / 262
const WORDMARK_HEIGHT = 20

function PortainerWordmark() {
  const src = `${import.meta.env.BASE_URL}portainer-wordmark.png`
  const mask = `url("${src}") left center / contain no-repeat`
  return (
    <span
      role="img"
      aria-label="Portainer"
      style={{
        display: 'block',
        height: WORDMARK_HEIGHT,
        width: Math.round(WORDMARK_HEIGHT * WORDMARK_ASPECT),
        background: 'var(--text, #111827)',
        WebkitMask: mask,
        mask,
      }}
    />
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
      <PortainerWordmark />
      <RunBadge />
    </div>
  )
}

export function SidebarLogoCollapsed() {
  return <RunBadge size="sm" />
}
