import { useEffect, useState } from 'react'

import { Badge } from '@ds/v3-components/Badge/Badge'
import { Button } from '@ds/v3-components/Button/Button'
import { Card } from '@ds/v3-components/Card/Card'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from '@ds/v3-components/Dialog/Dialog'
import { Skeleton } from '@ds/v3-components/Skeleton/Skeleton'
import { PageTitle } from '@ds/v3-templates/PageTitle/PageTitle'

import {
  listGitTargets,
  deleteGitTarget,
  testGitTarget,
  getGitTarget,
} from '../../lib/gitTargets.js'
import { useAppStore } from '../../store/useAppStore.js'
import { MONO_FONT } from '../service-detail/detailUi'
import { GitTargetForm } from './GitTargetForm'
import { EmptyRepoWarning } from './EmptyRepoWarning'
import { TestResultAlert, type GitTestResult } from './TestResultAlert'

/* eslint-disable @typescript-eslint/no-explicit-any */

export function GitTargetsPage() {
  const isAdmin = useAppStore((s) => s.isAdmin)
  const pushToast = useAppStore((s) => s.pushToast)
  const [connections, setConnections] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [testResults, setTestResults] = useState<Record<string, GitTestResult>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    name: string
  } | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const r = await listGitTargets()
      setConnections((r.connections || []) as any[])
    } catch {
      /* silent */
    } finally {
      setLoading(false)
    }
  }

  function onSaved() {
    setAdding(false)
    setEditing(null)
    void load()
  }

  async function handleEdit(conn: any) {
    // Fetch full payload (list endpoint strips token for security — edit needs it)
    try {
      const r = await getGitTarget(conn.id)
      setEditing(r.connection)
    } catch {
      // Fall back to list payload — user will re-enter token
      setEditing(conn)
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await deleteGitTarget(pendingDelete.id)
      setPendingDelete(null)
      void load()
    } catch (e: any) {
      pushToast('Delete failed: ' + (e?.message || String(e)), 'err')
    } finally {
      setDeleting(false)
    }
  }

  async function handleTest(id: string) {
    setTesting((t) => ({ ...t, [id]: true }))
    try {
      const r = await testGitTarget(id)
      setTestResults((t) => ({
        ...t,
        [id]: {
          ok: true,
          message: r.message,
          permissions: r.permissions,
          details: r.details || [],
        },
      }))
    } catch (e: any) {
      setTestResults((t) => ({ ...t, [id]: { ok: false, message: e.message || 'Test failed' } }))
    } finally {
      setTesting((t) => ({ ...t, [id]: false }))
    }
  }

  if (adding || editing) {
    return (
      <div
        className="ash-content"
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <PageTitle
          title={editing ? 'Edit Git Target' : 'Add Git Target'}
          description="Configure a repository to store Kubernetes manifests"
        />
        <GitTargetForm
          initial={editing}
          onSaved={onSaved}
          onCancel={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      </div>
    )
  }

  return (
    <div
      className="ash-content"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <PageTitle
        title="Git Targets"
        description="Repositories where Portainer-Run commits Kubernetes manifests for GitOps deployment. Credentials are stored encrypted. Add a target here before deploying."
        actions={<Button onClick={() => setAdding(true)}>+ Add Git Target</Button>}
      />

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
          <Skeleton height={84} radius={8} />
          <Skeleton height={84} radius={8} />
        </div>
      ) : connections.length === 0 ? (
        <div style={{ marginTop: 48, textAlign: 'center' }}>
          <div style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 12 }}>
            No git targets configured yet.
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 20 }}>
            Add a target to enable GitOps deployments. Each deployment can use its own
            repository.
          </div>
          <Button onClick={() => setAdding(true)}>Add your first Git Target</Button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
          {connections.map((conn) => (
            <Card key={conn.id}>
              <div
                style={{
                  padding: '14px 18px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 16,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                      {conn.name}
                    </span>
                    {conn.shared && (
                      <Badge tone="info" size="sm">
                        shared
                      </Badge>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 12,
                      color: 'var(--muted)',
                      marginBottom: 2,
                    }}
                  >
                    {conn.summary}
                  </div>
                  <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: 'var(--muted)' }}>
                    {[
                      conn.payload?.defaultBranch && `branch: ${conn.payload.defaultBranch}`,
                      conn.payload?.pathPrefix && `prefix: ${conn.payload.pathPrefix}`,
                      conn.payload?.authType && `auth: ${conn.payload.authType}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {testResults[conn.id] && (
                    <div style={{ marginTop: 8 }}>
                      <TestResultAlert result={testResults[conn.id]} />
                    </div>
                  )}
                  {testResults[conn.id]?.ok && testResults[conn.id]?.isEmpty && (
                    <div style={{ marginTop: 8 }}>
                      <EmptyRepoWarning
                        id={conn.id}
                        onInitialized={() =>
                          setTestResults((t) => ({
                            ...t,
                            [conn.id]: { ...t[conn.id], isEmpty: false },
                          }))
                        }
                      />
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                  <Button
                    variant="ghost"
                    onClick={() => void handleTest(conn.id)}
                    disabled={testing[conn.id]}
                  >
                    {testing[conn.id] ? 'Testing…' : 'Test'}
                  </Button>
                  {(!conn.shared || isAdmin) && (
                    <>
                      <Button variant="ghost" onClick={() => void handleEdit(conn)}>
                        Edit
                      </Button>
                      <Button
                        variant="light"
                        color="danger"
                        onClick={() =>
                          setPendingDelete({ id: conn.id, name: conn.name })
                        }
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(pendingDelete)}
        onClose={() => {
          if (!deleting) setPendingDelete(null)
        }}
        width={440}
      >
        <DialogHeader
          title="Delete git target"
          onClose={() => {
            if (!deleting) setPendingDelete(null)
          }}
        />
        <DialogBody>
          <div>
            Delete git target <strong>{pendingDelete?.name}</strong>? Deployments
            that reference it will no longer be able to sync. This cannot be undone.
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setPendingDelete(null)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            onClick={() => void confirmDelete()}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
