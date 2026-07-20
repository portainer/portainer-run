import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '@ds/v3-components/Button/Button'
import { FormControl, Input } from '@ds/v3-components/FormField/FormField'
import { Select } from '@ds/v3-components/Select/Select'

import { listGitTargets, listBranches } from '../../lib/gitTargets.js'
import { ROUTES } from '../../lib/routes.js'
import type { GitTarget } from '../../types/gitTarget'
import { MONO_FONT } from '../service-detail/detailUi'

const POLL_INTERVALS = [
  { value: '5m', label: '5 minutes' },
  { value: '15m', label: '15 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours (manual-ish)' },
]

export interface GitOpsSelection {
  gitTargetId: string
  branch: string
  pathPrefix: string
  pollInterval: string
}

/**
 * State for the GitOps step — target, branch, poll interval. Lives in the
 * deploy page (not the step component) so the wizard footer can render the
 * Commit & Deploy button with correct enabled/disabled state.
 */
export function useGitOpsSelection() {
  const [targets, setTargets] = useState<GitTarget[]>([])
  const [loadingTargets, setLoadingTargets] = useState(true)
  const [selectedTargetId, setSelectedTargetId] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [branch, setBranch] = useState('')
  const [customBranch, setCustomBranch] = useState('')
  const [useCustomBranch, setUseCustomBranch] = useState(false)
  const [pollInterval, setPollInterval] = useState('5m')
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const r = await listGitTargets()
        const list = (r.connections || []) as GitTarget[]
        setTargets(list)
        if (list.length === 1) setSelectedTargetId(list[0].id)
      } catch {
        /* silent */
      } finally {
        setLoadingTargets(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!selectedTargetId) {
      setBranches([])
      setBranch('')
      return
    }
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
        setBranch(
          list.find((b: string) => b === defaultBranch) || list[0] || '',
        )
      } catch {
        /* silent */
      } finally {
        setLoadingBranches(false)
      }
    })()
  }, [selectedTargetId, targets])

  const selectedTarget = targets.find((t) => t.id === selectedTargetId)
  const resolvedBranch = useCustomBranch ? customBranch.trim() : branch
  const pathPrefix = selectedTarget?.payload?.pathPrefix || ''

  function validate(): GitOpsSelection | null {
    if (!selectedTargetId) {
      setError('Select a Git target')
      return null
    }
    if (!resolvedBranch) {
      setError('Select or enter a branch')
      return null
    }
    setError('')
    return {
      gitTargetId: selectedTargetId,
      branch: resolvedBranch,
      pathPrefix,
      pollInterval,
    }
  }

  return {
    targets,
    loadingTargets,
    selectedTargetId,
    setSelectedTargetId,
    branches,
    loadingBranches,
    branch,
    setBranch,
    customBranch,
    setCustomBranch,
    useCustomBranch,
    setUseCustomBranch,
    pollInterval,
    setPollInterval,
    error,
    setError,
    resolvedBranch,
    pathPrefix,
    validate,
  }
}

export type GitOpsState = ReturnType<typeof useGitOpsSelection>

/**
 * GitOps step fields — shown after the user fills the deploy form.
 * Lets the user pick a saved git target, branch, and poll interval before
 * committing. Action buttons live in the wizard footer.
 */
export function GitOpsStepFields({
  state,
  appName,
  ns,
  sectionTitle,
}: {
  state: GitOpsState
  appName: string
  ns: string
  sectionTitle?: string
}) {
  const s = state
  const resolvedPath = [s.pathPrefix, ns, `${appName}.yaml`]
    .filter(Boolean)
    .join('/')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
        {sectionTitle || 'GitOps Target'}
      </div>

      {/* Manifest path preview */}
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '10px 14px',
          fontFamily: MONO_FONT,
          fontSize: 12,
          color: 'var(--muted)',
          lineHeight: 1.8,
        }}
      >
        <span style={{ color: 'var(--text)' }}>
          Manifest will be committed to:{' '}
        </span>
        {s.selectedTargetId ? (
          <span style={{ color: 'var(--accent, #2e90fa)' }}>
            {resolvedPath}
          </span>
        ) : (
          <span>select a target to preview path</span>
        )}
      </div>

      {/* Git target selector */}
      <div>
        <FormControl label="Git target">
          {s.loadingTargets ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading…</div>
          ) : s.targets.length === 0 ? (
            <div
              style={{
                padding: '12px 14px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 13,
                color: 'var(--muted)',
              }}
            >
              No git targets configured.{' '}
              <Link
                to={ROUTES.gitTargets}
                style={{ color: 'var(--accent, #2e90fa)' }}
              >
                Add one in Git Targets
              </Link>{' '}
              before deploying.
            </div>
          ) : (
            <Select
              value={s.selectedTargetId}
              onChange={(e) => {
                s.setSelectedTargetId(e.target.value)
                s.setError('')
              }}
              options={[
                { value: '', label: '— Select Git target —' },
                ...s.targets.map((t) => ({
                  value: t.id,
                  label: `${t.name}${t.summary ? ` (${t.summary})` : ''}`,
                })),
              ]}
            />
          )}
        </FormControl>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          Manage targets in{' '}
          <Link
            to={ROUTES.gitTargets}
            style={{ color: 'var(--accent, #2e90fa)' }}
          >
            Git Targets
          </Link>
          .
        </div>
      </div>

      {/* Branch + poll interval */}
      {s.selectedTargetId && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: 2 }}>
            <FormControl label="Branch">
              {!s.useCustomBranch ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <Select
                      value={s.branch}
                      onChange={(e) => s.setBranch(e.target.value)}
                      disabled={s.loadingBranches}
                      options={
                        s.loadingBranches
                          ? [{ value: '', label: 'Loading branches…' }]
                          : s.branches.length === 0
                            ? [{ value: '', label: 'No branches found' }]
                            : s.branches.map((b) => ({ value: b, label: b }))
                      }
                    />
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      s.setUseCustomBranch(true)
                      s.setCustomBranch('')
                    }}
                  >
                    New branch
                  </Button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Input
                    type="text"
                    value={s.customBranch}
                    onChange={(e) => s.setCustomBranch(e.target.value)}
                    placeholder="new-branch-name"
                    style={{ flex: 1, fontFamily: MONO_FONT, fontSize: 12 }}
                    autoFocus
                  />
                  <Button
                    variant="ghost"
                    onClick={() => {
                      s.setUseCustomBranch(false)
                      s.setCustomBranch('')
                    }}
                  >
                    Use existing
                  </Button>
                </div>
              )}
            </FormControl>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              {s.useCustomBranch
                ? 'Branch will be created from the repo default if it does not already exist.'
                : 'The manifest YAML will be committed to this branch.'}
            </div>
          </div>

          <div style={{ flex: 1 }}>
            <FormControl
              label="GitOps poll interval"
              hint="How often Portainer polls git for changes."
            >
              <Select
                value={s.pollInterval}
                onChange={(e) => s.setPollInterval(e.target.value)}
                options={POLL_INTERVALS}
              />
            </FormControl>
          </div>
        </div>
      )}

      {s.error && (
        <div style={{ color: 'var(--status-danger, #f04438)', fontSize: 13 }}>
          {s.error}
        </div>
      )}
    </div>
  )
}
