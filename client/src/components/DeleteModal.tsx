import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

import { Button } from '@ds/v3-components/Button/Button'
import { Checkbox } from '@ds/v3-components/Checkbox/Checkbox'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from '@ds/v3-components/Dialog/Dialog'
import { FormControl, Input } from '@ds/v3-components/FormField/FormField'

import { useAppStore } from '../store/useAppStore.js'
import { deleteApp } from '../services/deleteApp.js'
import { ROUTES } from '../lib/routes.js'
import { MONO_FONT } from '../pages/service-detail/detailUi'

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
    <Dialog open onClose={handleCancel} width={480}>
      <DialogHeader title="Delete deployment" onClose={handleCancel} />
      <DialogBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {deleting ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              <div>
                Deleting <strong>{name}</strong>
                {deleteManifest && isGitOps ? ' and cleaning up Git' : ''}… please wait.
              </div>
            </div>
          ) : (
            <>
              <div>
                Delete <strong>{name}</strong> in <strong>{ns}</strong>? Pods will be
                terminated. This cannot be undone.
              </div>

              <FormControl label="Type delete to confirm">
                <Input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="delete"
                  autoComplete="off"
                  autoFocus
                />
              </FormControl>

              {isGitOps && (
                <div
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: MONO_FONT }}>
                    This application was deployed via GitOps.
                  </div>

                  <Checkbox
                    checked={deleteManifest}
                    onChange={(checked) => setDeleteManifest(checked)}
                    label={
                      <span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 13,
                            color: 'var(--text)',
                            marginBottom: 2,
                          }}
                        >
                          Also remove from Git
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 11,
                            color: 'var(--muted)',
                            fontFamily: MONO_FONT,
                          }}
                        >
                          {gitPath} on {gitBranch}
                          {isVibeDeploy && <span style={{ opacity: 0.7 }}> + source files</span>}
                        </span>
                      </span>
                    }
                  />
                </div>
              )}
            </>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={handleCancel} disabled={deleting}>
          Cancel
        </Button>
        <Button
          color="danger"
          onClick={() => void confirm()}
          disabled={deleting || confirmText.toLowerCase() !== 'delete'}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
