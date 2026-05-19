import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore.js'
import { kubeFetch } from '../lib/api.js'
import { refreshCache } from '../services/refreshDeployments.js'
import { gitOpsDeleteManifest } from '../lib/gitTargets.js'
import { ROUTES } from '../lib/routes.js'

export function DeleteModal() {
  const deleteTarget = useAppStore((s) => s.deleteTarget)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const token = useAppStore((s) => s.token)
  const [deleting, setDeleting] = useState(false)
  const [deleteManifest, setDeleteManifest] = useState(false)
  const navigate = useNavigate()
  const loc = useLocation()

  if (!deleteTarget) return null

  const { envId, ns, name, gitTargetId, gitBranch, gitPath } = deleteTarget
  const isGitOps = Boolean(gitTargetId && gitBranch && gitPath)

  async function confirm() {
    setDeleting(true)
    try {
      // 1. Delete the Kubernetes Deployment
      const r = await kubeFetch(token, envId, `/apis/apps/v1/namespaces/${ns}/deployments/${name}`, {
        method: 'DELETE',
      })
      if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status)

      // 2. Delete associated resources — best-effort, 404s silently ignored
      await Promise.allSettled([
        kubeFetch(token, envId, `/api/v1/namespaces/${ns}/services/${name}`, { method: 'DELETE' }),
        kubeFetch(token, envId, `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${name}`, { method: 'DELETE' }),
        kubeFetch(token, envId, `/api/v1/namespaces/${ns}/persistentvolumeclaims/${name}`, { method: 'DELETE' }),
      ])

      // 3. Optionally delete the manifest from the Git repo
      if (isGitOps && deleteManifest) {
        try {
          await gitOpsDeleteManifest({ gitTargetId, branch: gitBranch, gitPath, appName: name })
        } catch (e) {
          // Non-fatal — warn but don't block
          useAppStore.getState().pushToast(
            `Deployment deleted but manifest removal failed: ${e?.message || 'unknown error'}`,
            'warn',
          )
        }
      }

      useAppStore.getState().pushToast(`Deployment "${name}" deleted`, 'ok')
      setDeleteTarget(null)
      setDeleteManifest(false)

      if (
        loc.pathname.startsWith(`${ROUTES.services}/`) &&
        loc.pathname !== ROUTES.services
      ) {
        navigate(ROUTES.services, { replace: true })
      }
      await refreshCache(false)
    } catch (e) {
      useAppStore.getState().pushToast('Delete failed: ' + (e?.message || e), 'err')
    } finally {
      setDeleting(false)
    }
  }

  function handleCancel() {
    setDeleteTarget(null)
    setDeleteManifest(false)
  }

  return (
    <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
      <div className="modal">
        <div className="modal-head">
          <h3 id="delete-modal-title">Delete deployment</h3>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            Delete <strong>{name}</strong> in <strong>{ns}</strong>? Pods will be terminated. This cannot be undone.
          </div>

          {isGitOps && (
            <div style={{
              background: 'var(--surface2, var(--bg2))',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                This service was deployed via GitOps.
              </div>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={deleteManifest}
                  onChange={(e) => setDeleteManifest(e.target.checked)}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontSize: 13, color: 'var(--text-bright)', marginBottom: 2 }}>
                    Also remove manifest from Git
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                    {gitPath} on {gitBranch}
                  </div>
                </div>
              </label>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleCancel}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => void confirm()}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
