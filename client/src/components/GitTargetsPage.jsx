import { useEffect, useState } from 'react'
import { listGitTargets, deleteGitTarget, testGitTarget, getGitTarget } from '../lib/gitTargets.js'
import { GitTargetForm } from './GitTargetForm.jsx'

export function GitTargetsPage() {
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)
  const [testResults, setTestResults] = useState({})
  const [testing, setTesting] = useState({})

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    try {
      const r = await listGitTargets()
      setConnections(r.connections || [])
    } catch { /* silent */ } finally {
      setLoading(false)
    }
  }

  function onSaved() {
    setAdding(false)
    setEditing(null)
    void load()
  }

  async function handleEdit(conn) {
    // Fetch full payload (list endpoint strips token for security — edit needs it)
    try {
      const r = await getGitTarget(conn.id)
      setEditing(r.connection)
    } catch {
      // Fall back to list payload — user will re-enter token
      setEditing(conn)
    }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Delete git target "${name}"?`)) return
    try {
      await deleteGitTarget(id)
      void load()
    } catch (e) {
      alert('Delete failed: ' + e.message)
    }
  }

  async function handleTest(id) {
    setTesting((t) => ({ ...t, [id]: true }))
    try {
      const r = await testGitTarget(id)
      setTestResults((t) => ({ ...t, [id]: { ok: true, message: r.message, permissions: r.permissions, details: r.details || [] } }))
    } catch (e) {
      setTestResults((t) => ({ ...t, [id]: { ok: false, message: e.message || 'Test failed' } }))
    } finally {
      setTesting((t) => ({ ...t, [id]: false }))
    }
  }

  if (adding || editing) {
    return (
      <div className="page active">
        <div className="page-header">
          <div>
            <div className="page-title">{editing ? 'Edit Git Target' : 'Add Git Target'}</div>
            <div className="page-sub">Configure a repository to store Kubernetes manifests</div>
          </div>
        </div>
        <GitTargetForm
          initial={editing}
          onSaved={onSaved}
          onCancel={() => { setAdding(false); setEditing(null) }}
        />
      </div>
    )
  }

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Git Targets</div>
          <div className="page-sub">
            Repositories where Portainer Run commits Kubernetes manifests for GitOps deployment.
            Credentials are stored encrypted. Add a target here before deploying.
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            + Add Git Target
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading-row"><div className="spinner" /> Loading…</div>
      ) : connections.length === 0 ? (
        <div style={{ marginTop: 48, textAlign: 'center' }}>
          <div style={{ color: 'var(--text-dim)', fontSize: 14, marginBottom: 12 }}>
            No git targets configured yet.
          </div>
          <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 20 }}>
            Add a target to enable GitOps deployments. Each deployment can use its own repository.
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            Add your first Git Target
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
          {connections.map((conn) => (
            <div key={conn.id} style={{
              background: 'var(--surface2, var(--bg2))',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '14px 18px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 16,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)', marginBottom: 3 }}>
                  {conn.name}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)', marginBottom: 2 }}>
                  {conn.summary}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                  {[
                    conn.payload?.defaultBranch && `branch: ${conn.payload.defaultBranch}`,
                    conn.payload?.pathPrefix && `prefix: ${conn.payload.pathPrefix}`,
                    conn.payload?.authType && `auth: ${conn.payload.authType}`,
                  ].filter(Boolean).join(' · ')}
                </div>
                {testResults[conn.id] && (
                  <div style={{
                    marginTop: 8, padding: '10px 12px', borderRadius: 6,
                    fontSize: 12, fontFamily: 'var(--mono)',
                    background: testResults[conn.id].ok && testResults[conn.id].permissions?.canWrite
                      ? 'rgba(74,222,128,0.08)'
                      : testResults[conn.id].ok && !testResults[conn.id].permissions?.canWrite
                      ? 'rgba(251,191,36,0.08)'
                      : 'rgba(248,113,113,0.08)',
                    color: testResults[conn.id].ok && testResults[conn.id].permissions?.canWrite
                      ? 'var(--green)'
                      : testResults[conn.id].ok && !testResults[conn.id].permissions?.canWrite
                      ? 'var(--amber)'
                      : 'var(--red)',
                    border: `1px solid ${testResults[conn.id].ok && testResults[conn.id].permissions?.canWrite
                      ? 'rgba(74,222,128,0.3)'
                      : testResults[conn.id].ok && !testResults[conn.id].permissions?.canWrite
                      ? 'rgba(251,191,36,0.3)'
                      : 'rgba(248,113,113,0.3)'}`,
                    display: 'flex', flexDirection: 'column', gap: 4,
                  }}>
                    <div style={{ fontWeight: 600 }}>
                      {testResults[conn.id].ok
                        ? (testResults[conn.id].permissions?.canWrite ? '✓' : '⚠')
                        : '✕'} {testResults[conn.id].message}
                    </div>
                    {testResults[conn.id].details?.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, opacity: 0.85 }}>
                        {testResults[conn.id].details.map((d, i) => <div key={i}>{d}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                <button type="button" className="btn btn-ghost btn-sm"
                  onClick={() => handleTest(conn.id)} disabled={testing[conn.id]}>
                  {testing[conn.id] ? 'Testing…' : 'Test'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm"
                  onClick={() => void handleEdit(conn)}>
                  Edit
                </button>
                <button type="button" className="btn btn-danger btn-sm"
                  onClick={() => void handleDelete(conn.id, conn.name)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
