import { useState } from 'react'

import { Button } from '@ds/v3-components/Button/Button'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from '@ds/v3-components/Dialog/Dialog'

import { useAppStore } from '../store/useAppStore.js'
import { restartDeployment } from '../lib/restartDeployment.js'
import { refreshCache } from '../services/refreshDeployments.js'
import { MONO_FONT } from '../pages/service-detail/detailUi'

/* eslint-disable @typescript-eslint/no-explicit-any */

export function RestartModal() {
  const restartTarget = useAppStore((s) => s.restartTarget)
  const setRestartTarget = useAppStore((s) => s.setRestartTarget)
  const token = useAppStore((s) => s.token)
  const pushToast = useAppStore((s) => s.pushToast)
  const [restarting, setRestarting] = useState(false)

  if (!restartTarget) return null

  const { envId, ns, name } = restartTarget

  async function confirm() {
    setRestarting(true)
    try {
      await restartDeployment(token, String(envId), ns, name)
      pushToast(
        `"${name}" is restarting — pods will be replaced one by one`,
        'ok',
      )
      setRestartTarget(null)
      void refreshCache(false)
    } catch (err: any) {
      pushToast('Restart failed: ' + (err?.message || String(err)), 'err')
    } finally {
      setRestarting(false)
    }
  }

  function handleCancel() {
    if (restarting) return
    setRestartTarget(null)
  }

  return (
    <Dialog open onClose={handleCancel} width={480}>
      <DialogHeader title="Restart deployment" onClose={handleCancel} />
      <DialogBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            Restart <strong>{name}</strong> in <strong>{ns}</strong>?
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              fontFamily: MONO_FONT,
              lineHeight: 1.5,
            }}
          >
            A rolling restart will terminate and replace pods one by one.
            Running instances will be briefly interrupted.
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={handleCancel} disabled={restarting}>
          Cancel
        </Button>
        <Button
          color="warning"
          onClick={() => void confirm()}
          disabled={restarting}
        >
          {restarting ? 'Restarting…' : 'Restart'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
