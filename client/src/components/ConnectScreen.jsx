import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore.js'
import { connectWithToken } from '../services/session.js'
import { ROUTES, getSafeAppPath } from '../lib/routes.js'

export function ConnectScreen() {
  const [apiToken, setApiToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const portainerBaseUrl = useAppStore((s) => s.portainerBaseUrl)
  const setPortainerBaseUrl = useAppStore((s) => s.setPortainerBaseUrl)
  const portainerFromServer = useAppStore((s) => s.portainerFromServer)
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
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 28,
              fontWeight: 600,
              color: 'var(--text-bright)',
              letterSpacing: '-0.04em',
              marginBottom: 8,
            }}
          >
            portainer<span style={{ color: 'var(--accent)' }}>_run</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
            Deploy and manage Kubernetes workloads via Portainer
          </div>
        </div>
        <div className="connect-card">
          <div className="ccard-head">
            <h2>Connect to Portainer</h2>
            <p>
              Set the same base URL you use in the browser (for example https://host:9443) and
              your personal API token. If the app server was started with <code>PORTAINER_URL</code>
              in the environment, you can leave the URL field empty to use that default.
            </p>
          </div>
          <div className="ccard-body">
            <div className="field">
              <label>Portainer base URL{portainerFromServer ? ' (optional override)' : null}</label>
              <input
                type="url"
                value={portainerBaseUrl}
                onChange={(e) => setPortainerBaseUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onConnect()
                }}
                placeholder="https://portainer.internal:9443"
                autoComplete="off"
              />
              <div className="hint">
                Same URL you use in the browser (scheme, host, port if not 443/80)
              </div>
            </div>
            <div className="field">
              <label>API Token</label>
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
              <div className="hint">Generate in Portainer → Account → Access Tokens</div>
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
