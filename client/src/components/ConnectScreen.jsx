import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore.js'
import { connectWithToken } from '../services/session.js'
import { ROUTES, getSafeAppPath } from '../lib/routes.js'

export function ConnectScreen() {
  const [apiToken, setApiToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const portainerBaseUrl = useAppStore((s) => s.portainerBaseUrl)
  const connectError = useAppStore((s) => s.connectError)
  const setConnectError = useAppStore((s) => s.setConnectError)
  const navigate = useNavigate()
  const location = useLocation()

  async function onConnect() {
    setConnecting(true)
    setConnectError('')
    try {
      const ok = await connectWithToken(apiToken)
      if (ok) {
        const to = getSafeAppPath(location.state?.from) || ROUTES.dashboard
        navigate(to, { replace: true })
      }
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="main" style={{ display: 'grid' }}>
      <div className="connect-wrap" style={{ gridColumn: '1 / -1' }}>
        <div style={{ marginBottom: 24, textAlign: 'center' }}>
          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', marginBottom: 8 }}>
            <img src="/portainer-logo.png" alt="Portainer" style={{ height: 26, width: 'auto', display: 'block' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
              <div style={{ width: 12, height: 12, background: 'var(--accent)', borderRadius: 2, flexShrink: 0 }} />
              <span style={{ fontFamily: '"Arial Black",Arial,sans-serif', fontWeight: 900, fontSize: 13, color: 'var(--accent)', letterSpacing: '0.12em', lineHeight: 1, textTransform: 'uppercase' }}>RUN</span>
            </div>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
            Deploy and manage Kubernetes workloads via Portainer
          </div>
        </div>
        <div className="connect-card">
          <div className="ccard-head">
            <h2>Log in to Portainer Run</h2>
          </div>
          <div className="ccard-body">
            <div className="field">
              <label>Portainer API Token</label>
              <input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onConnect()
                }}
                placeholder="ptr_xxxxxxxxxxxx"
                autoComplete="off"
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
              disabled={connecting}
              onClick={() => void onConnect()}
            >
              {connecting ? (
                <>
                  <span className="spinner" style={{ width: 14, height: 14 }} /> Connecting…
                </>
              ) : (
                'Connect'
              )}
            </button>
            {connectError ? (
              <div
                style={{
                  display: 'block',
                  color: 'var(--red)',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  lineHeight: 1.8,
                  background: 'rgba(239,68,68,.06)',
                  border: '1px solid rgba(239,68,68,.2)',
                  borderRadius: 6,
                  padding: '12px 14px',
                }}
              >
                {connectError}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
