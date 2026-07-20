import { useCallback, useEffect, useState } from 'react'

import { Badge } from '@ds/v3-components/Badge/Badge'
import { Button } from '@ds/v3-components/Button/Button'
import { Skeleton } from '@ds/v3-components/Skeleton/Skeleton'

import { kubeFetch } from '../../lib/api.js'
import { inflightDedupe } from '../../lib/inflightDedupe.js'
import { useAppStore } from '../../store/useAppStore.js'
import { age } from '../../lib/utils.js'
import { errMessage } from '../../lib/errors'
import type { OwnerReference, ReplicaSet } from '../../types/k8s'
import { MONO_FONT } from './detailUi'

export function ServiceDetailRevisionsTab({
  envId,
  namespace,
  name,
  onAfterRollback,
}: {
  envId: string
  namespace: string
  name: string
  onAfterRollback?: () => Promise<void> | void
}) {
  const token = useAppStore((s) => s.token)
  const pushToast = useAppStore((s) => s.pushToast)
  const [rows, setRows] = useState<ReplicaSet[] | null>(null)
  const [err, setErr] = useState('')
  const [rolling, setRolling] = useState<string | null>(null)

  const nsPath = encodeURIComponent(namespace)
  const namePath = encodeURIComponent(name)

  const fetchReplicaSetHistory = useCallback(async () => {
    return inflightDedupe(
      `revisions:rs:${String(envId)}:${namespace}:${name}`,
      async () => {
        const r = await kubeFetch(
          token,
          envId,
          `/apis/apps/v1/namespaces/${nsPath}/replicasets`,
        )
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const data = await r.json()
        return ((data.items || []) as ReplicaSet[])
          .filter((rs) =>
            rs.metadata.ownerReferences?.some(
              (o: OwnerReference) => o.kind === 'Deployment' && o.name === name,
            ),
          )
          .sort((a, b) => {
            const ra = parseInt(
              a.metadata.annotations?.['deployment.kubernetes.io/revision'] ||
                '0',
              10,
            )
            const rb = parseInt(
              b.metadata.annotations?.['deployment.kubernetes.io/revision'] ||
                '0',
              10,
            )
            return rb - ra
          })
      },
    )
  }, [token, envId, namespace, name, nsPath])

  const load = useCallback(async () => {
    if (!token || !envId || !namespace || !name) return
    setErr('')
    setRows(null)
    try {
      const items = await fetchReplicaSetHistory()
      setRows(items)
    } catch (e) {
      setErr(errMessage(e) || 'Failed to load revision history')
      setRows([])
    }
  }, [token, envId, namespace, name, fetchReplicaSetHistory])

  useEffect(() => {
    void load()
  }, [load])

  const rollbackTo = useCallback(
    async (rev: string) => {
      if (!token || !envId || !namespace || !name) return
      setRolling(rev)
      try {
        // K8s removed the apps/v1 .../rollback subresource (404 on modern clusters).
        // Match `kubectl rollout undo`: set deployment spec.template to the target ReplicaSet's.
        const history = await fetchReplicaSetHistory()
        const targetRs = history.find(
          (rs: ReplicaSet) =>
            String(
              rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ||
                '',
            ) === String(rev),
        )
        if (!targetRs?.spec?.template) {
          throw new Error('Revision ' + rev + ' not found')
        }
        const getDep = await kubeFetch(
          token,
          envId,
          `/apis/apps/v1/namespaces/${nsPath}/deployments/${namePath}`,
        )
        if (!getDep.ok) {
          const j = await getDep.json().catch(() => ({}))
          throw new Error(j?.message || 'HTTP ' + getDep.status)
        }
        const dep = await getDep.json()
        const template = JSON.parse(JSON.stringify(targetRs.spec.template))
        if (template.metadata?.labels) {
          const { ['pod-template-hash']: _h, ...rest } =
            template.metadata.labels
          template.metadata = {
            ...template.metadata,
            labels: rest,
          }
        }
        if (dep.status) delete dep.status
        dep.spec = { ...dep.spec, template }
        const putR = await kubeFetch(
          token,
          envId,
          `/apis/apps/v1/namespaces/${nsPath}/deployments/${namePath}`,
          { method: 'PUT', body: JSON.stringify(dep) },
        )
        if (!putR.ok) {
          const j = await putR.json().catch(() => ({}))
          throw new Error(j?.message || 'HTTP ' + putR.status)
        }
        pushToast(`Rollback to revision ${rev} initiated`, 'ok')
        if (onAfterRollback) await onAfterRollback()
        setTimeout(() => void load(), 1500)
      } catch (e) {
        pushToast('Rollback failed: ' + errMessage(e), 'err')
      } finally {
        setRolling(null)
      }
    },
    [
      token,
      envId,
      namespace,
      name,
      pushToast,
      onAfterRollback,
      load,
      fetchReplicaSetHistory,
      nsPath,
      namePath,
    ],
  )

  if (rows === null && !err) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: 'var(--muted)',
          fontSize: 13,
        }}
      >
        <Skeleton width={16} height={16} circle />
        Loading revisions…
      </div>
    )
  }

  if (err) {
    return (
      <p style={{ color: 'var(--status-danger, #f04438)', fontSize: 12 }}>
        {err}
        <br />
        <span style={{ color: 'var(--muted)' }}>
          This may mean the token cannot read ReplicaSets in namespace{' '}
          {namespace}.
        </span>
      </p>
    )
  }

  if (!rows || !rows.length) {
    return (
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>
        No revision history found.
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((rs) => {
        const rev =
          rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || '?'
        const img = rs.spec?.template?.spec?.containers?.[0]?.image || '—'
        const ready = rs.status?.readyReplicas || 0
        const desired = rs.spec?.replicas || 0
        const isRolling = rolling === String(rev)
        return (
          <div
            key={rs.metadata?.uid || rev}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md, 6px)',
              padding: '8px 12px',
            }}
          >
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: 11,
                color: 'var(--accent, #2e90fa)',
                flexShrink: 0,
              }}
            >
              Revision {rev}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: MONO_FONT,
                fontSize: 12,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={img}
            >
              {img}
            </span>
            <span
              style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}
            >
              {age(rs.metadata.creationTimestamp)}
            </span>
            <Badge tone={ready > 0 ? 'success' : 'neutral'} size="sm">
              {ready}/{desired}
            </Badge>
            <Button
              variant="ghost"
              onClick={() => void rollbackTo(String(rev))}
              disabled={isRolling}
            >
              {isRolling ? '…' : 'Rollback'}
            </Button>
          </div>
        )
      })}
    </div>
  )
}
