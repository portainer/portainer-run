import { useState } from 'react'
import { useAppStore } from '../store/useAppStore.js'
import { restartDeployment } from '../lib/restartDeployment.js'
import { refreshCache } from '../services/refreshDeployments.js'

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
      pushToast(`"${name}" is restarting — pods will be replaced one by one`, 'ok')
      setRestartTarget(null)
      void refreshCache(false)
    } catch (err) {
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
    <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="restart-modal-title">
      <div className="modal">
        <div className="modal-head">
          <h3 id="restart-modal-title">Restart deployment</h3>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            Restart <strong>{name}</strong> in <strong>{ns}</strong>?
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--mono)', lineHeight: 1.5 }}>
            A rolling restart will terminate and replace pods one by one. Running instances will be briefly interrupted.
          </div>
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleCancel}
            disabled={restarting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-warning btn-sm"
            onClick={() => void confirm()}
            disabled={restarting}
          >
            {restarting ? 'Restarting…' : 'Restart'}
          </button>
        </div>
      </div>
    </div>
  )
}
