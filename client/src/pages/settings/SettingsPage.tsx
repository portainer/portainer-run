import { useEffect, useState } from 'react'

import { Alert } from '@ds/v3-components/Alert/Alert'
import { Button } from '@ds/v3-components/Button/Button'
import { PageTitle } from '@ds/v3-templates/PageTitle/PageTitle'

import {
  acknowledgeKeyChange,
  getSetupStatus,
  type SetupStatus,
} from '../../lib/addonConfig'
import { errMessage } from '../../lib/errors'
import { useAppStore } from '../../store/useAppStore.js'
import { AddonConfigForm } from './AddonConfigForm'

const PAGE_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
}

/**
 * Portainer-Run's configuration, stored in Portainer and injected as env vars.
 *
 * Admin-only: the values are global to the installation, and Portainer's
 * settings endpoints reject non-admins anyway.
 */
export function SettingsPage() {
  const isAdmin = useAppStore((s) => s.isAdmin)
  const pushToast = useAppStore((s) => s.pushToast)

  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [acknowledging, setAcknowledging] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    void getSetupStatus()
      .then(setStatus)
      .catch(() => {
        // Non-fatal: the form still works, we just cannot show key state.
      })
  }, [isAdmin])

  async function handleAcknowledge() {
    setAcknowledging(true)
    try {
      await acknowledgeKeyChange()
      setStatus((s) => (s ? { ...s, keyStatus: 'ok' } : s))
      pushToast('Key change acknowledged', 'info')
    } catch (e) {
      pushToast('Could not acknowledge: ' + errMessage(e), 'err')
    } finally {
      setAcknowledging(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="ash-content" style={PAGE_STYLE}>
        <PageTitle
          title="Settings"
          description="Portainer-Run configuration."
        />
        <Alert
          tone="info"
          title="Administrator access required"
          description="These settings apply to the whole Portainer-Run installation, so only Portainer administrators can view or change them."
        />
      </div>
    )
  }

  return (
    <div className="ash-content" style={PAGE_STYLE}>
      <PageTitle
        title="Settings"
        description="Stored in Portainer and injected into Portainer-Run as environment variables. Saving re-applies the release, which restarts Portainer-Run to pick up the new values."
      />

      {status?.keyStatus === 'mismatch' && (
        <Alert
          tone="danger"
          title="The encryption key has changed"
          description={
            <span>
              {describeKeyDamage(status)} Restoring the previous key in
              Portainer recovers them. Acknowledging instead keeps the new key
              and abandons anything encrypted under the old one.
            </span>
          }
          action={
            <Button
              variant="light"
              color="danger"
              onClick={() => void handleAcknowledge()}
              disabled={acknowledging}
            >
              {acknowledging ? 'Acknowledging…' : 'Acknowledge and move on'}
            </Button>
          }
        />
      )}

      <AddonConfigForm submitLabel="Save configuration" />
    </div>
  )
}

function describeKeyDamage(status: SetupStatus): string {
  const parts: string[] = []
  if (status.affectedConnections > 0) {
    parts.push(
      `${status.affectedConnections} Git target${status.affectedConnections === 1 ? '' : 's'} can no longer be decrypted`,
    )
  }
  if (status.gatewayPskStale) {
    parts.push('the registered file-gateway identity no longer matches')
  }
  if (!parts.length) return 'Data encrypted under the previous key is at risk.'
  return `${parts.join(' and ')}.`.replace(/^./, (c) => c.toUpperCase())
}
