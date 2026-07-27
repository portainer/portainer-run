// Sidebar logo slots — the Portainer-Run brandmark, plus the Portainer wordmark.

const TILE_SIZE_EXPANDED = 32

/** Sizing is left to the caller — the collapsed slot's host styles it. */
function RunTile({ size }: { size?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}portainer-run.svg`}
      alt="Portainer-Run"
      style={size ? { width: size, height: size } : undefined}
    />
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
      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      title="Portainer-Run — Dashboard"
    >
      <RunTile size={TILE_SIZE_EXPANDED} />
      <PortainerWordmark />
    </div>
  )
}

export function SidebarLogoCollapsed() {
  return <RunTile />
}
