import { useState } from 'react'
import { createGitTarget, updateGitTarget, testGitTargetPayload } from '../lib/gitTargets.js'

const PROVIDERS = ['github', 'gitlab', 'gitea', 'other']

function defaultPayload() {
  return { provider: 'github', authType: 'pat', repo: '', token: '', url: '', username: '', pathPrefix: '', defaultBranch: 'main' }
}

/**
 * @param {object} props
 * @param {{ id, name, payload }|null} props.initial  — null for create
 * @param {(conn: object) => void} props.onSaved
 * @param {() => void} props.onCancel
 */
export function GitTargetForm({ initial, onSaved, onCancel }) {
  const [name, setName] = useState(initial?.name || '')
  const [payload, setPayload] = useState(initial?.payload || defaultPayload())
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set(key, value) {
    setPayload((p) => ({ ...p, [key]: value }))
    setTestResult(null)
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await testGitTargetPayload(payload)
      setTestResult({ ok: true, message: r.message, permissions: r.permissions, details: r.details || [] })
    } catch (e) {
      setTestResult({ ok: false, message: e.message || 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!name.trim()) { setError('Connection name is required'); return }
    if (!payload.repo.trim()) { setError('Repository is required'); return }
    if (payload.authType === 'pat' && !payload.token.trim()) { setError('Personal Access Token is required'); return }
    setError('')
    setSaving(true)
    try {
      let result
      if (initial?.id) {
        result = await updateGitTarget(initial.id, { name: name.trim(), payload })
      } else {
        result = await createGitTarget({ name: name.trim(), payload })
      }
      onSaved(result.connection)
    } catch (e) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="form-section" style={{ maxWidth: 600 }}>
      <div className="form-section-head">{initial ? 'Edit Git Target' : 'Add Git Target'}</div>
      <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        <Field label="Connection name" value={name} onChange={setName} placeholder="e.g. My K8s Manifests Repo" />

        <div className="frow" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Provider</label>
            <select value={payload.provider} onChange={(e) => set('provider', e.target.value)}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Authentication</label>
            <select value={payload.authType} onChange={(e) => set('authType', e.target.value)}>
              <option value="pat">Personal Access Token</option>
              <option value="ssh">SSH Key</option>
            </select>
          </div>
        </div>

        {(payload.provider === 'gitea' || payload.provider === 'other') && (
          <Field label="Git server URL" value={payload.url} onChange={(v) => set('url', v)}
            placeholder="https://git.internal.example.com" mono />
        )}

        <Field label="Repository (owner/repo)" value={payload.repo} onChange={(v) => set('repo', v)}
          placeholder="myorg/kubernetes-manifests" mono />

        {payload.authType === 'pat' && (
          <>
            <Field label="Git username" value={payload.username} onChange={(v) => set('username', v)}
              placeholder="your-git-username" mono />
            <Field label="Personal Access Token" value={payload.token} onChange={(v) => set('token', v)}
              placeholder="ghp_…" type="password" mono />
            <div className="hint">
              Username required for private repos and fine-grained PATs. For GitHub classic PATs use <code>oauth2</code>.
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              This token is stored encrypted and is also passed to Portainer when creating a GitOps stack, so Portainer can poll the repository for changes.
            </div>
          </>
        )}

        {payload.authType === 'ssh' && (
          <>
            <div className="field">
              <label>SSH private key</label>
              <textarea
                value={payload.sshKey || ''}
                onChange={(e) => set('sshKey', e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={6}
                style={{ fontFamily: 'var(--mono)', fontSize: 11 }}
              />
            </div>
            <Field label="SSH passphrase (optional)" value={payload.sshPassphrase || ''}
              onChange={(v) => set('sshPassphrase', v)} type="password" />
          </>
        )}

        <div className="frow" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label="Default branch" value={payload.defaultBranch} onChange={(v) => set('defaultBranch', v)}
              placeholder="main" mono />
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Path prefix (optional)" value={payload.pathPrefix} onChange={(v) => set('pathPrefix', v)}
              placeholder="portainer-run" mono />
            <div className="hint">Manifests saved at: prefix/namespace/appname.yaml</div>
          </div>
        </div>

        {testResult && (
          <div style={{
            padding: '12px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'var(--mono)',
            background: testResult.ok && testResult.permissions?.canWrite
              ? 'rgba(74,222,128,0.08)'
              : testResult.ok && !testResult.permissions?.canWrite
              ? 'rgba(251,191,36,0.08)'
              : 'rgba(248,113,113,0.08)',
            color: testResult.ok && testResult.permissions?.canWrite
              ? 'var(--green)'
              : testResult.ok && !testResult.permissions?.canWrite
              ? 'var(--amber)'
              : 'var(--red)',
            border: `1px solid ${
              testResult.ok && testResult.permissions?.canWrite
                ? 'rgba(74,222,128,0.3)'
                : testResult.ok && !testResult.permissions?.canWrite
                ? 'rgba(251,191,36,0.3)'
                : 'rgba(248,113,113,0.3)'
            }`,
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ fontWeight: 600 }}>
              {testResult.ok ? (testResult.permissions?.canWrite ? '✓' : '⚠') : '✕'} {testResult.message}
            </div>
            {testResult.details && testResult.details.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, opacity: 0.85 }}>
                {testResult.details.map((d, i) => (
                  <div key={i}>{d}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>
        )}

        <div className="form-actions" style={{ justifyContent: 'flex-start', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text', mono = false }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={mono ? { fontFamily: 'var(--mono)', fontSize: 12 } : {}}
      />
    </div>
  )
}
