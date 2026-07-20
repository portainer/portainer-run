import type { CSSProperties, ReactNode } from 'react'
import { Card } from '@ds/v3-components/Card/Card'

export const MONO_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

/**
 * Env keys whose values look sensitive and are masked in the UI. Mirrors
 * `isSensitiveEnvKey` in routes/vibe.js, where matching values are stored in a
 * Kubernetes Secret instead of being committed to git (issue #38).
 */
export const SECRET_PATTERN =
  /(^|[^A-Z])(PASSWORD|PASSWD|PASS|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH|DSN|CONNECTION[_-]?STRING|CERT|SIGNING)([^A-Z]|$)/i

/** Key/value grid used across the detail tabs. */
export function Kv({ pairs }: { pairs: [string, ReactNode][] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 220px) 1fr',
        gap: '8px 16px',
        alignItems: 'baseline',
      }}
    >
      {pairs.map(([k, v], i) => (
        <div key={`${k}-${i}`} style={{ display: 'contents' }}>
          <div
            style={{
              fontFamily: MONO_FONT,
              fontSize: 12,
              color: 'var(--muted)',
              wordBreak: 'break-all',
            }}
          >
            {k}
          </div>
          <div
            style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap' }}
          >
            {v == null ? '—' : typeof v === 'object' ? v : String(v)}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Titled section inside a tab panel. */
export function Section({
  title,
  children,
  style,
}: {
  title: string
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <div style={{ marginBottom: 24, ...style }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

/** Consistent surface for a tab body. */
export function TabPanel({ children }: { children: ReactNode }) {
  return (
    <Card>
      <div style={{ padding: 20 }}>{children}</div>
    </Card>
  )
}
