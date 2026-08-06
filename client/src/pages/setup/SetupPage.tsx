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
          description="Portainer-Run has not been configured yet."
        />
        <Alert
          tone="info"
          title="An administrator needs to finish setup"
          description="Portainer-Run is waiting for its configuration to be generated and stored in Portainer. Ask a Portainer administrator to open this page — deploys and Git targets are unavailable until then."
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
            ? 'This installation already has encrypted data, but the key that protects it is no longer available.'
            : keyAlreadyStored
              ? 'Portainer is already holding this installation’s configuration. Portainer-Run has not loaded it yet.'
              : 'Portainer-Run stores its configuration in Portainer. Generate the encryption key below — Portainer keeps it, and it stays the same for the life of this installation.'
        }
      />

      {/* Non-blocking: this only powers the import offer and key-damage detail. */}
      {loadError && (
        <Alert
          tone="warning"
          title="Could not read this instance’s setup status"
          description={`${loadError} Setup still works; Portainer-Run just cannot tell you whether this installation already has a hand-set key to import.`}
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
          title="The encryption key is missing — this is not a fresh install"
          description="Portainer-Run has Git target credentials encrypted with a key it is no longer receiving. Restore the original key in Portainer to recover them. Do not generate a new one: it would leave the existing credentials permanently unreadable."
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
          title="Could not read the stored configuration"
          description="Portainer's addon settings could not be reached, so it is not safe to generate a key — doing so could overwrite one this installation already relies on. Retry once Portainer is reachable."
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
          title="This browser cannot generate a key"
          description="Key generation needs the Web Crypto API, which requires a secure context. Open Portainer over HTTPS (or localhost) and try again."
        />
      )}

      {/*
        The key exists in Portainer but has not reached this container yet, so
        there is nothing to generate — offering to would overwrite a key that
        stored Git credentials already depend on. Either the release re-apply
        has not finished, or it failed.
      */}
      {keyAlreadyStored && (
        <Alert
          tone="info"
          title="A key is stored, but this instance has not loaded it"
          description="Portainer is holding the encryption key. Portainer-Run keeps settings in memory and loads them on demand, so it starts unconfigured after a restart until an administrator triggers a read. Check again to load them now."
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
          title="This install already has an encryption key"
          description="A key was set by hand (Helm values or an .env file) but Portainer is not storing it. Import it so upgrades keep re-injecting the same value — generating a new one instead would make existing Git target credentials unreadable."
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
          description="Portainer now stores this installation's encryption key and will re-inject it on every deploy."
        />
      )}

      {!adopted && !keyAlreadyStored && !storeUnreadable && !keyLost && (
        <AddonConfigForm
          requiredOnly
          submitLabel="Generate and save"
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
