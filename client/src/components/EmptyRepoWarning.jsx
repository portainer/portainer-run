import { useState } from 'react'
import { initializeGitTarget } from '../lib/gitTargets.js'

/**
 * Shown when a git target test reveals the repository has no commits.
 * Offers a one-click Initialize button that creates an initial commit so
 * the repo is ready to receive manifests and source files.
 *
 * @param {object} props
 * @param {string} props.id            git target ID
 * @param {() => void} props.onInitialized  called after successful init
 */
export default function EmptyRepoWarning({ id, onInitialized }) {
  const [initializing, setInitializing] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <div style={{
        padding: '10px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'var(--mono)',
        background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)',
        color: 'var(--green)',
      }}>
        ✓ Repository initialized — ready to deploy.
      </div>
    )
  }

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'var(--mono)',
      background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ color: 'var(--amber)', fontWeight: 600 }}>⚠ Repository is empty</div>
      <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.5 }}>
        This repository has no commits. Portainer Run needs at least one commit before it can push manifests and source files.
        Click Initialize to create an initial commit automatically.
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 11 }}>{error}</div>}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ alignSelf: 'flex-start' }}
        disabled={initializing}
        onClick={async () => {
          setInitializing(true)
          setError('')
          try {
            await initializeGitTarget(id)
            setDone(true)
            onInitialized?.()
          } catch (e) {
            setError(e?.message || 'Initialization failed')
          } finally {
            setInitializing(false)
          }
        }}
      >
        {initializing ? 'Initializing…' : 'Initialize Repository'}
      </button>
    </div>
  )
}
