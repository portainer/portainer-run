import { useEffect, useState } from 'react'

import { Button } from '@ds/v3-components/Button/Button'
import { StatusDot } from '@ds/v3-components/StatusDot/StatusDot'

import type { Deployment } from '../../types/k8s'
import { fetchExposureDetail } from './fetchExposureDetail.js'
import { Kv, MONO_FONT, SECRET_PATTERN, Section } from './detailUi'
import { friendlyStatus } from './deploymentStatus'

/** Live status/access details for an app, sourced from the env-status feed. */
export interface AppExtra {
  reason?: string
  accessUrl?: string | null
  accessLabel?: string | null
}

/** Exposure key/value rows fetched on demand for a single app. */
export function OverviewExposure({
  token,
  envId,
  namespace,
  name,
}: {
  token: string
  envId: string
  namespace: string
  name: string
}) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<[string, string][]>([])
  const [emptyMessage, setEmptyMessage] = useState('')
  const [exErr, setExErr] = useState('')

  useEffect(() => {
    if (!token || !envId || !namespace || !name) return
    let cancel = false
    setLoading(true)
    setExErr('')
    void (async () => {
      const res = await fetchExposureDetail(token, envId, namespace, name)
      if (cancel) return
      setLoading(false)
      if (res.error) {
        setExErr(res.error)
        setRows([])
        setEmptyMessage('')
        return
      }
      if (res.emptyMessage) {
        setEmptyMessage(res.emptyMessage)
        setRows([])
        return
      }
      setEmptyMessage('')
      setRows(res.rows || [])
    })()
    return () => {
      cancel = true
    }
  }, [token, envId, namespace, name])

  const dim = { color: 'var(--muted)', fontSize: 12 }
  if (loading) return <span style={dim}>Loading…</span>
  if (exErr) return <span style={dim}>Could not load exposure: {exErr}</span>
  if (emptyMessage) return <span style={dim}>{emptyMessage}</span>
  return <Kv pairs={rows} />
}

/** A single env value with click-to-reveal masking for secret-pattern keys. */
function EnvValue({ envKey, value }: { envKey: string; value: string }) {
  const [revealed, setRevealed] = useState(false)
  const isSecret = SECRET_PATTERN.test(envKey)
  const mono = { fontFamily: MONO_FONT, fontSize: 12, wordBreak: 'break-all' as const }
  if (!isSecret) {
    return <span style={mono}>{value}</span>
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={mono}>{revealed ? value : '••••••••'}</span>
      <Button variant="ghost" onClick={() => setRevealed((r) => !r)}>
        {revealed ? 'Hide' : 'Reveal'}
      </Button>
    </span>
  )
}

/**
 * Simple, business-builder Overview. Reads everything from the live cluster
 * objects already in hand (deployment + env-status cache), so it has no
 * dependency on the git target or the local database.
 */
export function SimpleOverview({ d, extra }: { d: Deployment; extra: AppExtra }) {
  const { status, base, reason } = friendlyStatus(d, extra?.reason)
  const container = d.spec?.template?.spec?.containers?.[0]
  const envs = (container?.env || [])
    .filter((e) => e && typeof e.name === 'string' && e.value != null)
    .map((e) => ({ key: e.name, value: String(e.value) }))
  const tone =
    status === 'running' ? 'success'
      : status === 'error' ? 'danger'
      : status === 'stopped' ? 'neutral'
      : 'warning'

  const accessUrl = extra?.accessUrl || null
  const accessLabel = extra?.accessLabel || null

  return (
    <>
      <Section title="Status">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StatusDot tone={tone} />
          <span style={{ fontSize: 14 }}>{base}</span>
        </div>
        {reason && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
            {reason}
          </div>
        )}
      </Section>

      <Section title="Address">
        {accessUrl ? (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}
          >
            <Button onClick={() => window.open(accessUrl, '_blank', 'noopener,noreferrer')}>
              Open your app
            </Button>
            <a
              href={accessUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: MONO_FONT,
                fontSize: 12,
                color: 'var(--muted)',
                wordBreak: 'break-all',
              }}
            >
              {accessUrl}
            </a>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {accessLabel || 'Not exposed publicly.'}
          </div>
        )}
      </Section>

      <Section title="Environment variables">
        {envs.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            No environment variables set.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(120px, 220px) 1fr',
              gap: '8px 16px',
              alignItems: 'center',
            }}
          >
            {envs.map((e: { key: string; value: string }, i: number) => (
              <div key={`${e.key}-${i}`} style={{ display: 'contents' }}>
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: 'var(--muted)',
                    wordBreak: 'break-all',
                  }}
                >
                  {e.key}
                </div>
                <div>
                  <EnvValue envKey={e.key} value={e.value} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  )
}
