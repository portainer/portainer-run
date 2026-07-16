import { useState } from 'react'
import { Alert } from '@ds/v3-components/Alert/Alert'
import { Button } from '@ds/v3-components/Button/Button'
import { initializeGitTarget } from '../../lib/gitTargets.js'

/**
 * Shown when a git target test reveals the repository has no commits.
 * Offers a one-click Initialize button that creates an initial commit so
 * the repo is ready to receive manifests and source files.
 */
export function EmptyRepoWarning({
  id,
  onInitialized,
}: {
  id: string
  onInitialized?: () => void
}) {
  const [initializing, setInitializing] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  if (done) {
    return <Alert tone="success" title="Repository initialized — ready to deploy." />
  }

  async function handleInitialize() {
    setInitializing(true)
    setError('')
    try {
      await initializeGitTarget(id)
      setDone(true)
      onInitialized?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Initialization failed')
    } finally {
      setInitializing(false)
    }
  }

  return (
    <Alert
      tone="warning"
      title="Repository is empty"
      description={
        // Alert renders the description inside a <p>, so only phrasing content
        // is valid here; the button goes in the `action` slot instead.
        <span style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span>
            This repository has no commits. Portainer-Run needs at least one commit before it
            can push manifests and source files. Click Initialize to create an initial commit
            automatically.
          </span>
          {error && (
            <span style={{ color: 'var(--status-danger, #f04438)', fontSize: 11 }}>{error}</span>
          )}
        </span>
      }
      action={
        <Button
          variant="ghost"
          size="sm"
          disabled={initializing}
          onClick={() => void handleInitialize()}
        >
          {initializing ? 'Initializing…' : 'Initialize Repository'}
        </Button>
      }
    />
  )
}
