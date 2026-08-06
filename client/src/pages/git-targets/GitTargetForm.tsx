import { useState } from 'react'

import { Button } from '@ds/v3-components/Button/Button'
import { Card } from '@ds/v3-components/Card/Card'
import { Checkbox } from '@ds/v3-components/Checkbox/Checkbox'
import { FormControl, Input } from '@ds/v3-components/FormField/FormField'
import { Select } from '@ds/v3-components/Select/Select'
import { Textarea } from '@ds/v3-components/Textarea/Textarea'

import {
  createGitTarget,
  updateGitTarget,
  testGitTargetPayload,
} from '../../lib/gitTargets.js'
import { useAppStore } from '../../store/useAppStore.js'
import { errMessage } from '../../lib/errors'
import type { GitTarget, GitTargetPayload } from '../../types/gitTarget'
import { MONO_FONT } from '../service-detail/detailUi'
import { TestResultAlert, type GitTestResult } from './TestResultAlert'

const PROVIDERS = ['github', 'gitlab', 'gitea', 'other']

function defaultPayload(): GitTargetPayload {
  return {
    provider: 'github',
    authType: 'pat',
    repo: '',
    token: '',
    url: '',
    username: '',
    pathPrefix: '',
    defaultBranch: 'main',
    tlsSkipVerify: false,
  }
}

// Fields left untrimmed: an SSH key spans multiple lines and a passphrase may
// legitimately contain leading/trailing spaces. Everything else is an
// identifier or URL where surrounding whitespace is always a mistake.
const UNTRIMMED_FIELDS = new Set(['sshKey', 'sshPassphrase'])

function trimmedPayload(p: GitTargetPayload): GitTargetPayload {
  const out: GitTargetPayload = { ...p }
  for (const key of Object.keys(out)) {
    const val = out[key]
    if (typeof val === 'string' && !UNTRIMMED_FIELDS.has(key)) {
      out[key] = val.trim()
    }
  }
  return out
}

const HINT_STYLE: React.CSSProperties = { fontSize: 12, color: 'var(--muted)' }
const MONO_INPUT: React.CSSProperties = { fontFamily: MONO_FONT, fontSize: 12 }

export function GitTargetForm({
  initial,
  onSaved,
  onCancel,
}: {
  /** null for create */
  initial: GitTarget | null
  onSaved: (conn: GitTarget) => void
  onCancel: () => void
}) {
  const isAdmin = useAppStore((s) => s.isAdmin)
  const [name, setName] = useState(initial?.name || '')
  const [payload, setPayload] = useState<GitTargetPayload>(
    initial?.payload || defaultPayload(),
  )
  const [shared, setShared] = useState(initial?.shared || false)
  const [, setSavedId] = useState(initial?.id || null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<GitTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set(key: string, value: string | boolean) {
    // Clearing the custom server URL falls back to the public host — a stale
    // skip-verify flag would otherwise silently disable TLS verification there too.
    const extra = key === 'url' && !value ? { tlsSkipVerify: false } : {}
    setPayload((p) => ({ ...p, [key]: value, ...extra }))
    setTestResult(null)
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const trimmed = trimmedPayload(payload)
      setPayload(trimmed)
      const r = await testGitTargetPayload(trimmed)
      setTestResult({
        ok: true,
        message: r.message,
        permissions: r.permissions,
        details: r.details || [],
        isEmpty: r.isEmpty,
      })
    } catch (e) {
      setTestResult({ ok: false, message: errMessage(e) || 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('Connection name is required')
      return
    }
    if (!payload.repo.trim()) {
      setError('Repository is required')
      return
    }
    if (payload.authType === 'pat' && !payload.token.trim()) {
      setError('Personal Access Token is required')
      return
    }
    setError('')
    setSaving(true)
    try {
      // Trim to strip stray whitespace (e.g. a trailing space in the repo slug,
      // a common copy-paste artefact that otherwise 404s against the provider).
      const trimmed = trimmedPayload(payload)
      setPayload(trimmed)
      // The JSDoc types in gitTargets.js omit `shared`, but the API accepts it.
      const body = { name: name.trim(), payload: trimmed, shared }
      let result
      if (initial?.id) {
        result = await updateGitTarget(initial.id, body)
      } else {
        result = await createGitTarget(body)
      }
      setSavedId(result?.connection?.id || initial?.id)
      onSaved(result.connection)
    } catch (e) {
      setError(errMessage(e) || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card style={{ maxWidth: 600 }}>
      <div
        style={{
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
          {initial ? 'Edit Git Target' : 'Add Git Target'}
        </div>

        <FormControl label="Connection name">
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My K8s Manifests Repo"
          />
        </FormControl>

        <div style={{ display: 'flex', gap: 12 }}>
          <FormControl label="Provider" style={{ flex: 1 }}>
            <Select
              value={payload.provider}
              onChange={(e) => set('provider', e.target.value)}
              options={PROVIDERS.map((p) => ({ value: p, label: p }))}
            />
          </FormControl>
          <FormControl label="Authentication" style={{ flex: 1 }}>
            <Select
              value={payload.authType}
              onChange={(e) => set('authType', e.target.value)}
              options={[
                { value: 'pat', label: 'Personal Access Token' },
                { value: 'ssh', label: 'SSH Key' },
              ]}
            />
          </FormControl>
        </div>

        {(payload.provider === 'gitea' || payload.provider === 'other') && (
          <FormControl label="Git server URL">
            <Input
              type="text"
              value={payload.url || ''}
              onChange={(e) => set('url', e.target.value)}
              placeholder="https://git.internal.example.com"
              style={MONO_INPUT}
            />
          </FormControl>
        )}

        {payload.provider === 'github' && (
          <>
            <FormControl label="GitHub server URL (optional)">
              <Input
                type="text"
                value={payload.url || ''}
                onChange={(e) => set('url', e.target.value)}
                placeholder="https://github.your-company.com"
                style={MONO_INPUT}
              />
            </FormControl>
            <div style={HINT_STYLE}>
              Leave blank for github.com. For GitHub Enterprise Server, enter
              your host — the GitHub-compatible API at <code>/api/v3</code> is
              used automatically.
            </div>
          </>
        )}

        {payload.provider === 'gitlab' && (
          <>
            <FormControl label="GitLab server URL (optional)">
              <Input
                type="text"
                value={payload.url || ''}
                onChange={(e) => set('url', e.target.value)}
                placeholder="https://gitlab.your-company.com"
                style={MONO_INPUT}
              />
            </FormControl>
            <div style={HINT_STYLE}>
              Leave blank for gitlab.com. For self-hosted GitLab, enter your
              host — the GitLab API at <code>/api/v4</code> is used
              automatically.
            </div>
          </>
        )}

        {payload.url && (
          <Checkbox
            checked={Boolean(payload.tlsSkipVerify)}
            onChange={(checked) => set('tlsSkipVerify', checked)}
            label={
              <span>
                <span style={{ color: 'var(--text)', fontWeight: 500 }}>
                  Skip TLS verification
                </span>
                <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                  Only enable this if the git server uses a self-signed
                  certificate. Your token crosses this connection, so an
                  attacker on the network path could intercept it while this is
                  on.
                </span>
              </span>
            }
          />
        )}

        <FormControl label="Repository (owner/repo)">
          <Input
            type="text"
            value={payload.repo || ''}
            onChange={(e) => set('repo', e.target.value)}
            placeholder="myorg/kubernetes-manifests"
            style={MONO_INPUT}
          />
        </FormControl>

        {payload.authType === 'pat' && (
          <>
            <FormControl label="Git username">
              <Input
                type="text"
                value={payload.username || ''}
                onChange={(e) => set('username', e.target.value)}
                placeholder="your-git-username"
                style={MONO_INPUT}
              />
            </FormControl>
            <FormControl label="Personal Access Token">
              <Input
                type="password"
                value={payload.token || ''}
                onChange={(e) => set('token', e.target.value)}
                placeholder="ghp_…"
                style={MONO_INPUT}
              />
            </FormControl>
            <div style={HINT_STYLE}>
              Username required for private repos and fine-grained PATs. For
              GitHub classic PATs use <code>oauth2</code>.
            </div>
            <TokenScopeNotice provider={payload.provider} />
            <div style={{ ...HINT_STYLE, marginTop: 4 }}>
              This token is stored encrypted and is also passed to Portainer
              when creating a GitOps stack, so Portainer can poll the repository
              for changes.
            </div>
          </>
        )}

        {payload.authType === 'ssh' && (
          <>
            <FormControl label="SSH private key">
              <Textarea
                value={payload.sshKey || ''}
                onChange={(e) => set('sshKey', e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={6}
                style={{ fontFamily: MONO_FONT, fontSize: 11 }}
              />
            </FormControl>
            <FormControl label="SSH passphrase (optional)">
              <Input
                type="password"
                value={payload.sshPassphrase || ''}
                onChange={(e) => set('sshPassphrase', e.target.value)}
              />
            </FormControl>
          </>
        )}

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <FormControl label="Default branch">
              <Input
                type="text"
                value={payload.defaultBranch || ''}
                onChange={(e) => set('defaultBranch', e.target.value)}
                placeholder="main"
                style={MONO_INPUT}
              />
            </FormControl>
          </div>
          <div style={{ flex: 1 }}>
            <FormControl
              label="Path prefix (optional)"
              hint="Manifests saved at: prefix/namespace/appname.yaml"
            >
              <Input
                type="text"
                value={payload.pathPrefix || ''}
                onChange={(e) => set('pathPrefix', e.target.value)}
                placeholder="portainer-run"
                style={MONO_INPUT}
              />
            </FormControl>
          </div>
        </div>

        {testResult && <TestResultAlert result={testResult} />}

        {error && (
          <div style={{ color: 'var(--status-danger, #f04438)', fontSize: 13 }}>
            {error}
          </div>
        )}

        {isAdmin && (
          <Checkbox
            checked={shared}
            onChange={(checked) => setShared(checked)}
            label={
              <span>
                <span style={{ color: 'var(--text)', fontWeight: 500 }}>
                  Shared target
                </span>
                <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                  Visible to all users in deploy flows
                </span>
              </span>
            }
          />
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            variant="ghost"
            onClick={() => void handleTest()}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

/**
 * Minimum PAT scope guidance per provider. Advisory only — there is no reliable
 * cross-provider API to introspect a token's granted scopes before use, so we
 * state the required scope rather than validating it. See issue #33.
 */
function TokenScopeNotice({ provider }: { provider: string }) {
  let body
  if (provider === 'gitlab') {
    body = (
      <>
        Requires a token with the <code>api</code> scope. Narrower combinations
        such as <code>read_api</code> + <code>write_repository</code> pass
        GitLab&apos;s own checks but fail when Portainer Run writes manifests
        and creates the GitOps stack.
      </>
    )
  } else if (provider === 'github') {
    body = (
      <>
        Classic tokens require the <code>repo</code> scope. Fine-grained tokens
        require <b>Contents</b> read and write permission on the target
        repository.
      </>
    )
  } else if (provider === 'gitea') {
    body = (
      <>
        Requires a token with <code>write:repository</code> (repository read and
        write) permission.
      </>
    )
  } else {
    body = (
      <>
        Provide a token with repository read and write permission so manifests
        can be committed.
      </>
    )
  }
  return <div style={{ ...HINT_STYLE, marginTop: 4 }}>{body}</div>
}
