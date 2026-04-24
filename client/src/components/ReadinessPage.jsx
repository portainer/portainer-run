import { useCallback, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAppStore, isEnvDisabled } from '../store/useAppStore.js'
import { saveDisabledEnvs } from '../services/disabledEnvs.js'
import { ROUTES } from '../lib/routes.js'
import {
  overallEnvStatus,
  runReadinessForEnv,
} from '../lib/readinessChecks.js'

const CHECK_LABELS = ['Ingress', 'Load Balancer', 'Storage', 'Nodes', 'GPU']

const shieldPath =
  'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1-8.618 3.04A12.02 12.02 0 0 0 3 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z'

function resultStatusClass(ok) {
  if (ok === true) return 'rcheck-ok'
  if (ok === null) return 'rcheck-warn'
  return 'rcheck-fail'
}

function resultIcon(ok) {
  if (ok === true) return '✓'
  if (ok === null) return '⚠'
  return '✗'
}

function envBadgeInfo(status) {
  if (status === 'checking') {
    return { text: 'Checking...', className: 'ready-env-badge r-badge-neutral' }
  }
  if (status === 'ready') {
    return { text: 'Ready', className: 'ready-env-badge r-badge-pass' }
  }
  if (status === 'issues') {
    return { text: 'Issues found', className: 'ready-env-badge r-badge-fail' }
  }
  return { text: 'Warnings', className: 'ready-env-badge r-badge-warn' }
}

/**
 * @param {object} props
 * @param {import('../lib/readinessChecks.js').ReadinessCheckResult | undefined} props.result
 * @param {string} props.columnLabel
 * @param {'loading' | 'done'} props.phase
 */
function CheckCell({ result, columnLabel, phase }) {
  if (phase === 'loading' || (phase === 'done' && !result)) {
    return (
      <div className="ready-check">
        <div className="ready-check-label">{columnLabel}</div>
        <div className="ready-check-status rcheck-loading">
          <div
            className="spinner"
            style={{ borderTopColor: 'var(--text-dim)' }}
          />
          Checking
        </div>
        <div className="ready-check-detail" />
      </div>
    )
  }
  return (
    <div className="ready-check">
      <div className="ready-check-label">{columnLabel}</div>
      <div
        className={`ready-check-status ${resultStatusClass(result.ok)}`.trim()}
      >
        <span>{resultIcon(result.ok)}</span> {result.label}
      </div>
      <div className="ready-check-detail">{result.detail || ''}</div>
    </div>
  )
}

export function ReadinessPage() {
  const isAdmin = useAppStore((s) => s.isAdmin)
  const token = useAppStore((s) => s.token)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const setDisabledEnvs = useAppStore((s) => s.setDisabledEnvs)
  const pushToast = useAppStore((s) => s.pushToast)

  const [byEnv, setByEnv] = useState(
    /** @type {null | Record<string, { phase: 'loading' | 'done' | 'error', results?: import('../lib/readinessChecks.js').ReadinessCheckResult[], err?: string }>} */ (
      null
    ),
  )
  const [running, setRunning] = useState(false)

  const runChecks = useCallback(async () => {
    if (!token || !environments.length) return
    setRunning(true)
    const next = {}
    for (const env of environments) {
      next[env.Id] = { phase: 'loading' }
    }
    setByEnv(next)
    await Promise.all(
      environments.map(async (env) => {
        try {
          const results = await runReadinessForEnv(token, env.Id)
          setByEnv((prev) => ({
            ...prev,
            [env.Id]: { phase: 'done', results },
          }))
        } catch (e) {
          setByEnv((prev) => ({
            ...prev,
            [env.Id]: {
              phase: 'error',
              err: e instanceof Error ? e.message : String(e),
            },
          }))
        }
      }),
    )
    setRunning(false)
  }, [token, environments])

  const toggleEnvDisabled = useCallback(
    async (envId, envName) => {
      if (!token) return
      const cur = useAppStore.getState().disabledEnvs
      const was = isEnvDisabled({ disabledEnvs: cur }, envId)
      const next = { ...cur }
      if (was) {
        delete next[String(envId)]
        pushToast(`“${envName}” re-enabled for deployments`, 'ok')
      } else {
        next[String(envId)] = {
          reason: 'Disabled via Cluster Readiness',
          disabledAt: new Date().toISOString(),
        }
        pushToast(`“${envName}” disabled — no new deployments allowed`, 'ok')
      }
      setDisabledEnvs(next)
      try {
        await saveDisabledEnvs(
          token,
          useAppStore.getState().environments,
          next,
        )
      } catch (e) {
        pushToast(
          'Could not save environment state: ' +
            (e instanceof Error ? e.message : String(e)),
          'err',
        )
      }
    },
    [token, setDisabledEnvs, pushToast],
  )

  if (!isAdmin) return <Navigate to={ROUTES.dashboard} replace />

  const showGrid = byEnv !== null

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Cluster Readiness</div>
          <div className="page-sub">
            Verify each environment has ingress, load balancing, storage, and
            healthy nodes
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={running || !environments.length}
          onClick={runChecks}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d={shieldPath} />
          </svg>
          Run checks
        </button>
      </div>

      {!environments.length ? (
        <p style={{ color: 'var(--text-dim)' }}>
          No Kubernetes environments are connected.
        </p>
      ) : !showGrid ? (
        <div className="empty">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <path d={shieldPath} />
          </svg>
          <h3>Run checks to verify all environments</h3>
          <p>
            Checks ingress controller, load balancer, storage type, node health,
            and GPU capacity across every connected environment.
          </p>
        </div>
      ) : (
        <div className="ready-grid">
          {environments.map((env) => {
            const row = byEnv?.[env.Id]
            const dis = isEnvDisabled({ disabledEnvs }, env.Id)
            let badgeState = 'checking'
            if (row?.phase === 'done' && row.results) {
              badgeState = overallEnvStatus(row.results)
            } else if (row?.phase === 'error') {
              badgeState = 'issues'
            }
            const { text, className } = envBadgeInfo(
              row?.phase === 'loading' ? 'checking' : badgeState,
            )
            const checkPhase = row?.phase === 'loading' ? 'loading' : 'done'

            return (
              <div className="ready-env-card" key={env.Id}>
                <div className="ready-env-head">
                  <span className="ready-env-name">{env.Name}</span>
                  <span className={className}>{text}</span>
                  <button
                    type="button"
                    className={
                      dis
                        ? 'readiness-toggle readiness-toggle--enable'
                        : 'readiness-toggle readiness-toggle--disable'
                    }
                    onClick={() => toggleEnvDisabled(env.Id, env.Name)}
                  >
                    {dis ? '✓ Re-enable' : '⊘ Disable'}
                  </button>
                </div>
                {row?.phase === 'error' ? (
                  <div className="readiness-env-error">
                    {row.err || 'Checks failed.'}
                  </div>
                ) : (
                  <div className="ready-checks">
                    {CHECK_LABELS.map((col, i) => (
                      <CheckCell
                        key={col}
                        columnLabel={col}
                        phase={checkPhase}
                        result={row?.results?.[i]}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
