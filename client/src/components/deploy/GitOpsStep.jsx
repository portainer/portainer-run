import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listGitTargets, listBranches, gitOpsValidate } from '../../lib/gitTargets.js'
import { ROUTES } from '../../lib/routes.js'

const POLL_INTERVALS = [
  { value: '5m',  label: '5 minutes' },
  { value: '15m', label: '15 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h',  label: '1 hour' },
  { value: '24h', label: '24 hours (manual-ish)' },
]

/**
 * GitOps step — shown after the user fills the deploy form.
 * Lets the user pick a saved git target, branch, poll interval, and optionally
 * dry-run validate manifests before committing.
 *
 * @param {object} props
 * @param {string} props.appName
 * @param {string} props.ns
 * @param {string} props.envId
 * @param {object} props.deployParams   — full staged deploy params for dry-run
 * @param {(selection: { gitTargetId, branch, pathPrefix, pollInterval }) => void} props.onConfirm
 * @param {() => void} props.onBack
 * @param {boolean} props.deploying
 */
export function GitOpsStep({ appName, ns, envId, deployParams, onConfirm, onBack, deploying }) {
  const [targets, setTargets] = useState([])
  const [loadingTargets, setLoadingTargets] = useState(true)
  const [selectedTargetId, setSelectedTargetId] = useState('')
  const [branches, setBranches] = useState([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [branch, setBranch] = useState('')
  const [customBranch, setCustomBranch] = useState('')
  const [useCustomBranch, setUseCustomBranch] = useState(false)
  const [pollInterval, setPollInterval] = useState('5m')
  const [error, setError] = useState('')

  // Dry-run state
  const [validating, setValidating] = useState(false)
  const [validateResults, setValidateResults] = useState(null)

  useEffect(() => {
    void (async () => {
      try {
        const r = await listGitTargets()
        const list = r.connections || []
        setTargets(list)
        if (list.length === 1) setSelectedTargetId(list[0].id)
      } catch { /* silent */ } finally {
        setLoadingTargets(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!selectedTargetId) { setBranches([]); setBranch(''); return }
    setLoadingBranches(true)
    setBranches([])
    setBranch('')
    void (async () => {
      try {
        const r = await listBranches(selectedTargetId)
        const list = r.branches || []
        setBranches(list)
        const target = targets.find((t) => t.id === selectedTargetId)
        const defaultBranch = target?.payload?.defaultBranch || 'main'
        setBranch(list.find((b) => b === defaultBranch) || list[0] || '')
      } catch { /* silent */ } finally {
        setLoadingBranches(false)
      }
    })()
  }, [selectedTargetId, targets])

  const selectedTarget = targets.find((t) => t.id === selectedTargetId)
  const resolvedBranch = useCustomBranch ? customBranch.trim() : branch
  const pathPrefix = selectedTarget?.payload?.pathPrefix || ''
  const resolvedPath = [pathPrefix, ns, `${appName}.yaml`].filter(Boolean).join('/')

  async function handleValidate() {
    if (!deployParams || !envId) { setError('Deploy params not available for validation'); return }
    setValidating(true)
    setValidateResults(null)
    setError('')
    try {
      const r = await gitOpsValidate({ deployParams, envId })
      setValidateResults(r.results || [])
    } catch (e) {
      setError('Validation failed: ' + (e.message || 'Unknown error'))
    } finally {
      setValidating(false)
    }
  }

  function handleConfirm() {
    if (!selectedTargetId) { setError('Select a Git target'); return }
    if (!resolvedBranch) { setError('Select or enter a branch'); return }
    setError('')
    onConfirm({ gitTargetId: selectedTargetId, branch: resolvedBranch, pathPrefix, pollInterval })
  }

  const validateAllPassed = validateResults && validateResults.every((r) => r.status === 'pass' || r.status === 'warn')

  return (
    <div className="form-section">
      <div className="form-section-head">GitOps Target</div>
      <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Manifest path preview */}
        <div style={{
          background: 'var(--surface2, var(--bg2))', border: '1px solid var(--border)',
          borderRadius: 6, padding: '10px 14px',
          fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.8,
        }}>
          <span style={{ color: 'var(--text-bright)' }}>Manifest will be committed to: </span>
          {selectedTargetId
            ? <span style={{ color: 'var(--accent)' }}>{resolvedPath}</span>
            : <span style={{ color: 'var(--text-dim)' }}>select a target to preview path</span>}
        </div>

        {/* Git target selector */}
        <div className="field">
          <label>Git target</label>
          {loadingTargets ? (
            <div className="hint">Loading…</div>
          ) : targets.length === 0 ? (
            <div style={{
              padding: '12px 14px', background: 'var(--surface2, var(--bg2))',
              border: '1px solid var(--border)', borderRadius: 6,
              fontSize: 13, color: 'var(--text-dim)',
            }}>
              No git targets configured.{' '}
              <Link to={ROUTES.gitTargets} style={{ color: 'var(--accent)' }}>
                Add one in Git Targets
              </Link>{' '}
              before deploying.
            </div>
          ) : (
            <select value={selectedTargetId} onChange={(e) => { setSelectedTargetId(e.target.value); setError(''); setValidateResults(null) }}>
              <option value="">— Select Git target —</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.summary ? ` (${t.summary})` : ''}
                </option>
              ))}
            </select>
          )}
          <div className="hint">
            Manage targets in{' '}
            <Link to={ROUTES.gitTargets} style={{ color: 'var(--accent)' }}>Git Targets</Link>.
          </div>
        </div>

        {/* Branch + poll interval */}
        {selectedTargetId && (
          <div className="frow" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="field" style={{ flex: 2 }}>
              <label>Branch</label>
              {!useCustomBranch ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    disabled={loadingBranches}
                    style={{ flex: 1 }}
                  >
                    {loadingBranches && <option value="">Loading branches…</option>}
                    {!loadingBranches && branches.length === 0 && <option value="">No branches found</option>}
                    {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => { setUseCustomBranch(true); setCustomBranch('') }}>
                    New branch
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={customBranch}
                    onChange={(e) => setCustomBranch(e.target.value)}
                    placeholder="new-branch-name"
                    style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 12 }}
                    autoFocus
                  />
                  <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => { setUseCustomBranch(false); setCustomBranch('') }}>
                    Use existing
                  </button>
                </div>
              )}
              <div className="hint">
                {useCustomBranch
                  ? 'Branch will be created from the repo default if it does not already exist.'
                  : 'The manifest YAML will be committed to this branch.'}
              </div>
            </div>

            <div className="field" style={{ flex: 1 }}>
              <label>GitOps poll interval</label>
              <select value={pollInterval} onChange={(e) => setPollInterval(e.target.value)}>
                {POLL_INTERVALS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <div className="hint">How often Portainer polls git for changes.</div>
            </div>
          </div>
        )}

        {/* Dry-run validation */}
        {selectedTargetId && deployParams && (
          <div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void handleValidate()}
              disabled={validating || deploying}
              style={{ marginBottom: validateResults ? 10 : 0 }}
            >
              {validating ? 'Validating…' : 'Dry-run validate'}
            </button>
            <div className="hint" style={{ marginTop: 4 }}>
              Checks manifests against the Kubernetes API without committing anything.
            </div>

            {validateResults && (
              <div style={{
                marginTop: 8, background: 'var(--surface2, var(--bg2))',
                border: `1px solid ${validateAllPassed ? 'var(--green)' : 'var(--red)'}`,
                borderRadius: 6, padding: '10px 14px',
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                {validateResults.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 12 }}>
                    <span style={{
                      flexShrink: 0, fontFamily: 'var(--mono)',
                      color: r.status === 'pass' ? 'var(--green)' : r.status === 'warn' ? 'var(--amber)' : 'var(--red)',
                    }}>
                      {r.status === 'pass' ? '✓' : r.status === 'warn' ? '!' : '✕'}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', flexShrink: 0 }}>
                      {r.kind}/{r.name}
                    </span>
                    <span style={{ color: r.status === 'pass' ? 'var(--text-dim)' : r.status === 'warn' ? 'var(--amber)' : 'var(--red)' }}>
                      {r.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onBack} disabled={deploying}>
            ← Back
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={deploying || !selectedTargetId || !resolvedBranch}
          >
            {deploying ? (
              <><span className="spinner" style={{ width: 14, height: 14, display: 'inline-block' }} /> Deploying…</>
            ) : 'Commit & Deploy'}
          </button>
        </div>
      </div>
    </div>
  )
}
