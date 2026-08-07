import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'

import { Alert } from '@ds/v3-components/Alert/Alert'
import { Button } from '@ds/v3-components/Button/Button'
import { Skeleton } from '@ds/v3-components/Skeleton/Skeleton'
import { PageTitle } from '@ds/v3-templates/PageTitle/PageTitle'

import {
  ENCRYPTION_KEY_ENTRY,
  adoptLocalKey,
  canGenerateSecrets,
  entryIsSet,
  getSetupStatus,
  listConfig,
  readServerConfig,
  reloadSettings,
  waitForRestart,
  type SetupStatus,
} from '../../lib/addonConfig'
import { errMessage } from '../../lib/errors'
import { ROUTES } from '../../lib/routes.js'
import { useAppStore } from '../../store/useAppStore.js'
import { AddonConfigForm } from '../settings/AddonConfigForm'

const PAGE_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  maxWidth: 640,
}

/**
 * First-run setup. The admin's browser generates the encryption key and writes
 * it to Portainer over their own session. Nothing here needs the key while it
 * runs — it is only used later — so there is no ordering problem.
 */
export function SetupPage() {
  const isAdmin = useAppStore((s) => s.isAdmin)
  const setupRequired = useAppStore((s) => s.setupRequired)
  const keyLost = useAppStore((s) => s.keyLost)

  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [keyAlreadyStored, setKeyAlreadyStored] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [adopting, setAdopting] = useState(false)
  const [adoptError, setAdoptError] = useState('')
  const [adopted, setAdopted] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  /** Portainer's settings store could not be read — we cannot tell what is stored. */
  const [storeUnreadable, setStoreUnreadable] = useState(false)

  /**
   * Read boot state and stored config independently: chaining them would let a
   * status failure answer "no key stored" and offer to overwrite a live one.
   */
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')

    const [statusResult, entriesResult] = await Promise.allSettled([
      getSetupStatus(),
      // Only admins can read the store; non-admins never reach the form.
      isAdmin ? listConfig() : Promise.resolve([]),
    ])

    if (statusResult.status === 'fulfilled') {
      setStatus(statusResult.value)
    } else {
      setStatus(null)
      setLoadError(
        errMessage(statusResult.reason) || 'Could not read setup status.',
      )
    }

    if (entriesResult.status === 'fulfilled') {
      setKeyAlreadyStored(
        entriesResult.value.some(
          (e) => e.key === ENCRYPTION_KEY_ENTRY && entryIsSet(e),
        ),
      )
      setStoreUnreadable(false)
    } else {
      // We cannot prove a key is absent, so do not act as if it is.
      setKeyAlreadyStored(false)
      setStoreUnreadable(true)
    }

    setLoading(false)
  }, [isAdmin])

  useEffect(() => {
    void load()
  }, [load])

  /** Re-read settings, then reload into the app if that configured it. */
  async function handleRecheck() {
    setRechecking(true)
    try {
      let live = false
      try {
        live = await reloadSettings()
      } catch {
        const cfg = await readServerConfig()
        live = cfg?.setupRequired === false
      }
      if (live) {
        window.location.reload()
        return
      }
      await load()
    } finally {
      setRechecking(false)
    }
  }

  async function handleAdopt() {
    setAdopting(true)
    setAdoptError('')
    const before = await readServerConfig()
    try {
      await adoptLocalKey()
      setAdopted(true)
      await waitForRestart(before?.bootId)
    } catch (e) {
      setAdoptError(errMessage(e) || 'Could not import the existing key.')
    } finally {
      setAdopting(false)
    }
  }

  // Configured, so nothing to set up. AppRoutes only redirects *to* /setup, so
  // without this anyone landing here waits for a key that already arrived.
  if (!setupRequired) return <Navigate to={ROUTES.services} replace />

  if (loading) {
    return (
      <div className="ash-content" style={PAGE_STYLE}>
        <Skeleton height={80} radius={8} />
        <Skeleton height={200} radius={8} />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="ash-content" style={PAGE_STYLE}>
        <PageTitle
          title="Setup required"
          description="Portainer-Run is not set up yet."
        />
        <Alert
          tone="info"
          title="An administrator needs to finish setup"
          description="Ask a Portainer administrator to open this page and finish setting up Portainer-Run. Deploying apps and saving Git targets are unavailable until then."
        />
      </div>
    )
  }

  // An operator-set key is already in our environment but Portainer does not
  // hold it. Importing it keeps existing Git targets decryptable and the
  // gateway identity stable; generating a new one would break both.
  const canImportExistingKey =
    Boolean(status?.canAdoptLocalKey) && !keyAlreadyStored

  return (
    <div className="ash-content" style={PAGE_STYLE}>
      <PageTitle
        title="Set up Portainer-Run"
        description={
          keyLost
            ? 'Portainer-Run has protected data, but the key that unlocks it is missing.'
            : keyAlreadyStored
              ? 'Your settings are saved in Portainer. Portainer-Run has not picked them up yet.'
              : 'Just one step: create the key that protects your saved credentials. Portainer keeps it safe, and you will not need to touch it again.'
        }
      />

      {/* Non-blocking: this only powers the import offer and key-damage detail. */}
      {loadError && (
        <Alert
          tone="warning"
          title="Could not check setup status"
          description={`${loadError} You can still finish setup, but Portainer-Run cannot check whether an existing key is available to reuse.`}
          action={
            <Button variant="ghost" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      )}

      {/* Key gone but encrypted data exists: generating over it is unrecoverable. */}
      {keyLost && (
        <Alert
          tone="danger"
          title="The encryption key is missing"
          description="This is not a new installation. Portainer-Run has saved Git credentials that need the original key to read them. Restore that key in Portainer to recover them; creating a new one would make them permanently unreadable."
          action={
            <Button
              variant="ghost"
              onClick={() => void handleRecheck()}
              disabled={rechecking}
            >
              {rechecking ? 'Checking…' : 'Check again'}
            </Button>
          }
        />
      )}

      {/* Cannot prove a key is absent, so refuse to generate rather than guess. */}
      {storeUnreadable && (
        <Alert
          tone="danger"
          title="Could not reach your settings"
          description="Portainer could not be reached, so creating a key now is not safe: it could replace one already in use. Try again in a moment."
          action={
            <Button variant="ghost" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      )}

      {!keyAlreadyStored && !canGenerateSecrets() && (
        <Alert
          tone="danger"
          title="This browser cannot create a key"
          description="Creating a key securely requires an HTTPS connection. Open Portainer over HTTPS (or localhost) and try again."
        />
      )}

      {/* Key stored but not loaded: generating would overwrite a live one. */}
      {keyAlreadyStored && (
        <Alert
          tone="info"
          title="Almost there"
          description="Your encryption key is saved in Portainer. Portainer-Run just needs to load it. Check again to finish."
          action={
            <Button
              variant="ghost"
              onClick={() => void handleRecheck()}
              disabled={rechecking}
            >
              {rechecking ? 'Checking…' : 'Check again'}
            </Button>
          }
        />
      )}

      {canImportExistingKey && !adopted && (
        <Alert
          tone="warning"
          title="An existing encryption key was found"
          description="This installation already has a key that Portainer is not storing yet. Import it so your saved Git credentials keep working. Creating a new one would make them unreadable."
          action={
            <Button onClick={() => void handleAdopt()} disabled={adopting}>
              {adopting ? 'Importing…' : 'Import existing key'}
            </Button>
          }
        />
      )}

      {adoptError && (
        <Alert tone="danger" title="Import failed" description={adoptError} />
      )}

      {adopted && (
        <Alert
          tone="success"
          title="Existing key imported"
          description="Portainer is now keeping your encryption key safe."
        />
      )}

      {!adopted && !keyAlreadyStored && !storeUnreadable && !keyLost && (
        <AddonConfigForm
          requiredOnly
          submitLabel="Create key and finish setup"
          onSaved={(phase) => {
            // A new pod means the key arrived, so reload and drop the gate.
            // Otherwise it is stored but not in use — re-read and say so.
            if (phase === 'restarted') {
              window.location.reload()
              return
            }
            void load()
          }}
        />
      )}
    </div>
  )
}
