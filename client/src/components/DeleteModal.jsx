import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore.js'
import { deleteApp } from '../services/deleteApp.js'
import { ROUTES } from '../lib/routes.js'

export function DeleteModal() {
  const deleteTarget = useAppStore((s) => s.deleteTarget)
  const setDeleteTarget = useAppStore((s) => s.setDeleteTarget)
  const [deleting, setDeleting] = useState(false)
  const [deleteManifest, setDeleteManifest] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const navigate = useNavigate()
  const loc = useLocation()

  if (!deleteTarget) return null

  const { ns, name, gitTargetId, gitBranch, gitPath, vibeSourcePath } = deleteTarget
  const isVibeDeploy = Boolean(vibeSourcePath)
  const isGitOps = Boolean(gitTargetId && gitBranch && gitPath)

  async function confirm() {
    // Keep the modal open with a progress indicator while the delete runs.
    // Staying open blocks a second delete from being started mid-flight, which
    // is what previously let progress state bleed across deletes (issue #44).
    const target = deleteTarget
    const alsoManifest = deleteManifest
    const wasOnDetail =
      loc.pathname.startsWith(`${ROUTES.services}/`) && loc.pathname !== ROUTES.services

    setDeleting(true)
    const ok = await deleteApp(target, { deleteManifest: alsoManifest })
    setDeleting(false)

    if (ok) {
      setDeleteTarget(null)
      setDeleteManifest(false)
      setConfirmText('')
      if (wasOnDetail) navigate(ROUTES.services, { replace: true })
    }
    // On failure the modal stays open (error toast already shown) so the
    // user can retry or cancel.
  }

  function handleCancel() {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteManifest(false)
    setConfirmText('')
  }

  return (
    <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
      <div className="modal">
        <div className="modal-head">
          <h3 id="delete-modal-title">Delete deployment</h3>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {deleting ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
              <span className="spinner" aria-hidden="true" />
              <div>
                Deleting <strong>{name}</strong>
                {deleteManifest && isGitOps ? ' and cleaning up Git' : ''}… please wait.
              </div>
            </div>
          ) : (
            <>
              <div>
                Delete <strong>{name}</strong> in <strong>{ns}</strong>? Pods will be terminated. This cannot be undone.
              </div>

              <div className="field">
                <label style={{ fontSize: 12 }}>Type <strong>delete</strong> to confirm</label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="delete"
                  autoComplete="off"
                  autoFocus
                />
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
                    This application was deployed via GitOps.
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
                        Also remove from Git
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                        {gitPath} on {gitBranch}
                        {isVibeDeploy && <span style={{ opacity: 0.7 }}> + source files</span>}
                      </div>
                    </div>
                  </label>
                </div>
              )}
            </>
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
            disabled={deleting || confirmText.toLowerCase() !== 'delete'}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
