import { useCallback, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Loader2, ShieldCheck } from 'lucide-react'

import { Badge } from '@ds/v3-components/Badge/Badge'
import type { BadgeTone } from '@ds/v3-components/Badge/Badge'
import { Button } from '@ds/v3-components/Button/Button'
import { Card } from '@ds/v3-components/Card/Card'
import { StatusDot } from '@ds/v3-components/StatusDot/StatusDot'
import { PageTitle } from '@ds/v3-templates/PageTitle/PageTitle'

import { useAppStore, isEnvDisabled } from '../../store/useAppStore.js'
import { saveDisabledEnvs } from '../../services/disabledEnvs.js'
import { ROUTES } from '../../lib/routes.js'
import { overallEnvStatus, runReadinessForEnv } from '../../lib/readinessChecks.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHECK_LABELS = ['Ingress', 'Load Balancer', 'Storage', 'Nodes', 'GPU']

interface CheckResult {
  ok: boolean | null
  label: string
  detail: string
}

type EnvRow = {
  phase: 'loading' | 'done' | 'error'
  results?: CheckResult[]
  err?: string
}

function envBadgeInfo(status: string): { text: string; tone: BadgeTone } {
  if (status === 'checking') return { text: 'Checking...', tone: 'neutral' }
  if (status === 'ready') return { text: 'Ready', tone: 'success' }
  if (status === 'issues') return { text: 'Issues found', tone: 'danger' }
  return { text: 'Warnings', tone: 'warning' }
}

function CheckCell({
  result,
  columnLabel,
  phase,
}: {
  result: CheckResult | undefined
  columnLabel: string
  phase: 'loading' | 'done'
}) {
  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: 'var(--muted)',
    marginBottom: 4,
  }

  if (phase === 'loading' || (phase === 'done' && !result)) {
    return (
      <div>
        <div style={labelStyle}>{columnLabel}</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <Loader2 size={11} className="animate-spin" />
          Checking
        </div>
        <div />
      </div>
    )
  }
  const r = result as CheckResult
  const tone = r.ok === true ? 'success' : r.ok === null ? 'warning' : 'danger'
  return (
    <div>
      <div style={labelStyle}>{columnLabel}</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: 'var(--text)',
        }}
      >
        <StatusDot tone={tone} />
        {r.label}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{r.detail || ''}</div>
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

  const [byEnv, setByEnv] = useState<Record<string, EnvRow> | null>(null)
  const [running, setRunning] = useState(false)

  const runChecks = useCallback(async () => {
    if (!token || !environments.length) return
    setRunning(true)
    const next: Record<string, EnvRow> = {}
    for (const env of environments) {
      next[env.Id] = { phase: 'loading' }
    }
    setByEnv(next)
    await Promise.all(
      environments.map(async (env: any) => {
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
    async (envId: string | number, envName: string) => {
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
        await saveDisabledEnvs(token, useAppStore.getState().environments, next)
      } catch (e) {
        pushToast(
          'Could not save environment state: ' + (e instanceof Error ? e.message : String(e)),
          'err',
        )
      }
    },
    [token, setDisabledEnvs, pushToast],
  )

  if (!isAdmin) return <Navigate to={ROUTES.dashboard} replace />

  const showGrid = byEnv !== null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageTitle
        title="Cluster Readiness"
        description="Verify each environment has ingress, load balancing, storage, and healthy nodes"
        actions={
          <Button
            size="sm"
            disabled={running || !environments.length}
            leftSection={<ShieldCheck size={13} />}
            onClick={() => void runChecks()}
          >
            Run checks
          </Button>
        }
      />

      {!environments.length ? (
        <p style={{ color: 'var(--muted)' }}>No Kubernetes environments are connected.</p>
      ) : !showGrid ? (
        <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)' }}>
          <ShieldCheck size={32} style={{ marginBottom: 12 }} />
          <h3 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--text)' }}>
            Run checks to verify all environments
          </h3>
          <p style={{ margin: 0, fontSize: 13 }}>
            Checks ingress controller, load balancer, storage type, node health, and GPU
            capacity across every connected environment.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {environments.map((env: any) => {
            const row = byEnv?.[env.Id]
            const dis = isEnvDisabled({ disabledEnvs }, env.Id)
            let badgeState = 'checking'
            if (row?.phase === 'done' && row.results) {
              badgeState = overallEnvStatus(row.results)
            } else if (row?.phase === 'error') {
              badgeState = 'issues'
            }
            const { text, tone } = envBadgeInfo(
              row?.phase === 'loading' ? 'checking' : badgeState,
            )
            const checkPhase = row?.phase === 'loading' ? 'loading' : 'done'

            return (
              <Card key={env.Id}>
                <div style={{ padding: '14px 18px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      marginBottom: 12,
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                      {env.Name}
                    </span>
                    <Badge tone={tone} size="sm">
                      {text}
                    </Badge>
                    <span style={{ marginLeft: 'auto' }}>
                      <Button
                        variant="light"
                        color={dis ? 'success' : 'danger'}
                        size="xs"
                        onClick={() => void toggleEnvDisabled(env.Id, env.Name)}
                      >
                        {dis ? '✓ Re-enable' : '⊘ Disable'}
                      </Button>
                    </span>
                  </div>
                  {row?.phase === 'error' ? (
                    <div style={{ color: 'var(--status-danger, #f04438)', fontSize: 12 }}>
                      {row.err || 'Checks failed.'}
                    </div>
                  ) : (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${CHECK_LABELS.length}, 1fr)`,
                        gap: 12,
                      }}
                    >
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
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
