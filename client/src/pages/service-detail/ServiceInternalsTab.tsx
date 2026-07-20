import type { ReactNode } from 'react'

import type { Deployment } from '../../types/k8s'
import { age } from '../../lib/utils.js'
import { Kv, MONO_FONT, Section } from './detailUi'
import { envDisplayValue } from './deploymentStatus'
import { OverviewExposure } from './SimpleOverviewTab'

/** Technical "App internals" tab: raw status, config, env, exposure, containers. */
export function ServiceInternalsTab({
  d,
  token,
  envId,
  namespace,
  name,
}: {
  d: Deployment
  token: string
  envId: string
  namespace: string
  name: string
}) {
  return (
    <>
      <Section title="Status">
        {(() => {
          const r = d.status?.readyReplicas || 0
          const des = d.spec?.replicas || 0
          const cond = (d.status?.conditions || []).find(
            (c: { type: string; status: string }) =>
              c.type === 'Available' && c.status === 'False',
          )
          const statusKv: [string, ReactNode][] = [
            ['Ready instances', des === 0 ? 'Scaled to zero' : `${r} / ${des}`],
            ['Updated instances', d.status?.updatedReplicas || 0],
            ['Available instances', d.status?.availableReplicas || 0],
            ['Observed generation', d.status?.observedGeneration || 0],
          ]
          if (cond) statusKv.push(['Failure reason', cond.message || '—'])
          return <Kv pairs={statusKv} />
        })()}
      </Section>
      <Section title="Configuration">
        {(() => {
          const spec = d.spec
          return (
            <Kv
              pairs={[
                ['Namespace', namespace],
                ['Instances', d.spec?.replicas],
                ['Strategy', spec?.strategy?.type || '—'],
                [
                  'Max surge',
                  spec?.strategy?.rollingUpdate?.maxSurge != null
                    ? String(spec.strategy.rollingUpdate.maxSurge)
                    : '—',
                ],
                [
                  'Max unavailable',
                  spec?.strategy?.rollingUpdate?.maxUnavailable != null
                    ? String(spec.strategy.rollingUpdate.maxUnavailable)
                    : '—',
                ],
                [
                  'Created',
                  d.metadata.creationTimestamp
                    ? new Date(d.metadata.creationTimestamp).toLocaleString()
                    : '—',
                ],
                ['Age', age(d.metadata.creationTimestamp)],
              ]}
            />
          )
        })()}
      </Section>
      <Section title="Environment variables">
        {(() => {
          const env = d.spec?.template?.spec?.containers?.[0]?.env || []
          const pairs: [string, ReactNode][] = env.length
            ? env.map((e) => [e.name, envDisplayValue(e)])
            : [['(none)', '—']]
          return <Kv pairs={pairs} />
        })()}
      </Section>
      <Section title="Exposure">
        <OverviewExposure
          token={token}
          envId={envId}
          namespace={namespace}
          name={name}
        />
      </Section>
      <Section title="Labels">
        <Kv
          pairs={
            Object.keys(d.metadata?.labels || {}).length
              ? (Object.entries(d.metadata.labels || {}) as [string, string][])
              : [['(none)', '—']]
          }
        />
      </Section>
      <Section title="Containers">
        {(d.spec?.template?.spec?.containers || []).length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No containers.</p>
        ) : (
          (d.spec?.template?.spec?.containers || []).map((c, i: number) => {
            const ports =
              (c.ports || [])
                .map((p) => `${p.containerPort}/${p.protocol || 'TCP'}`)
                .join(', ') || '—'
            const res = c.resources || {}
            const mounts = (c.volumeMounts || [])
              .map((v) => v.mountPath + ' → ' + v.name)
              .join(', ')
            return (
              <div
                key={c.name || i}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg, 8px)',
                  marginBottom: 12,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--bg)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {c.name}
                  </span>
                  <span
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 10,
                      color:
                        i === 0 ? 'var(--accent, #2e90fa)' : 'var(--muted)',
                    }}
                  >
                    {i === 0 ? 'primary' : 'sidecar'}
                  </span>
                </div>
                <div style={{ padding: 12 }}>
                  <Kv
                    pairs={[
                      ['Image', c.image],
                      ['Ports', ports],
                      ['Pull policy', c.imagePullPolicy || 'IfNotPresent'],
                      [
                        'CPU request/limit',
                        `${res.requests?.cpu || '—'} / ${res.limits?.cpu || '—'}`,
                      ],
                      [
                        'Mem request/limit',
                        `${res.requests?.memory || '—'} / ${res.limits?.memory || '—'}`,
                      ],
                      ['Volume mounts', mounts || '—'],
                    ]}
                  />
                </div>
              </div>
            )
          })
        )}
      </Section>
    </>
  )
}
