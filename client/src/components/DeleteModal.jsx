import { useState } from 'react'
import { useAppStore } from '../store/useAppStore.js'
import { kubeFetch } from '../lib/api.js'
import { refreshCache } from '../services/refreshDeployments.js'

export function DeleteModal() {
  const deleteTarget = useAppStore((s) => s.deleteTarget)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const token = useAppStore((s) => s.token)
  const [deleting, setDeleting] = useState(false)

  if (!deleteTarget) return null
  const { envId, ns, name } = deleteTarget

  async function confirm() {
    setDeleting(true)
    try {
      const r = await kubeFetch(token, envId, `/apis/apps/v1/namespaces/${ns}/deployments/${name}`, {
        method: 'DELETE',
      })
      if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status)
      useAppStore.getState().pushToast(`Deployment “${name}” deleted`, 'ok')
      setDeleteTarget(null)
      await refreshCache(false)
    } catch (e) {
      useAppStore.getState().pushToast('Delete failed: ' + (e?.message || e), 'err')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      className="modal-overlay open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-modal-title"
    >
      <div className="modal">
        <div className="modal-head">
          <h3 id="delete-modal-title">Delete deployment</h3>
        </div>
        <div className="modal-body">
          Delete <strong>{name}</strong> in {ns}? Pods will be terminated. This cannot be undone.
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setDeleteTarget(null)}
            disabled={deleting}
          >
            Cancel
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void confirm()} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
