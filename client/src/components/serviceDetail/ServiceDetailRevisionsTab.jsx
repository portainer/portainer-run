import { useCallback, useEffect, useState } from 'react'
import { kubeFetch } from '../../lib/api.js'
import { inflightDedupe } from '../../lib/inflightDedupe.js'
import { useAppStore } from '../../store/useAppStore.js'
import { age } from '../../lib/utils.js'

/**
 * @param {object} props
 * @param {string} props.envId
 * @param {string} props.namespace
 * @param {string} props.name
 * @param {() => Promise<void> | void} [props.onAfterRollback]
 */
export default function ServiceDetailRevisionsTab({ envId, namespace, name, onAfterRollback }) {
  const token = useAppStore((s) => s.token)
  const pushToast = useAppStore((s) => s.pushToast)
  const [rows, setRows] = useState(/** @type {object[] | null} */ (null))
  const [err, setErr] = useState('')
  const [rolling, setRolling] = useState(/** @type {string | null} */ (null))

  const nsPath = encodeURIComponent(namespace)
  const namePath = encodeURIComponent(name)

  const fetchReplicaSetHistory = useCallback(async () => {
    return inflightDedupe(`revisions:rs:${String(envId)}:${namespace}:${name}`, async () => {
      const r = await kubeFetch(
        token,
        envId,
        `/apis/apps/v1/namespaces/${nsPath}/replicasets`,
      )
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const data = await r.json()
      return (data.items || [])
        .filter((rs) =>
          rs.metadata.ownerReferences?.some(
            (o) => o.kind === 'Deployment' && o.name === name,
          ),
        )
        .sort((a, b) => {
          const ra = parseInt(
            a.metadata.annotations?.['deployment.kubernetes.io/revision'] || '0',
            10,
          )
          const rb = parseInt(
            b.metadata.annotations?.['deployment.kubernetes.io/revision'] || '0',
            10,
          )
          return rb - ra
        })
    })
  }, [token, envId, namespace, name, nsPath])

  const load = useCallback(async () => {
    if (!token || !envId || !namespace || !name) return
    setErr('')
    setRows(null)
    try {
      const items = await fetchReplicaSetHistory()
      setRows(items)
    } catch (e) {
      setErr(e?.message || 'Failed to load revision history')
      setRows([])
    }
  }, [token, envId, namespace, name, fetchReplicaSetHistory])

  useEffect(() => {
    void load()
  }, [load])

  const rollbackTo = useCallback(
    async (rev) => {
      if (!token || !envId || !namespace || !name) return
      setRolling(rev)
      try {
        // K8s removed the apps/v1 .../rollback subresource (404 on modern clusters).
        // Match `kubectl rollout undo`: set deployment spec.template to the target ReplicaSet's.
        const history = await fetchReplicaSetHistory()
        const targetRs = history.find(
          (rs) =>
            String(
              rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || '',
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
        const template = /** @type {object} */ (
          JSON.parse(JSON.stringify(targetRs.spec.template))
        )
        if (template.metadata?.labels) {
          const { ['pod-template-hash']: _h, ...rest } = template.metadata.labels
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
        pushToast('Rollback failed: ' + (e?.message || String(e)), 'err')
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
      <div className="loading-row">
        <div className="spinner" />
        Loading revisions…
      </div>
    )
  }

  if (err) {
    return (
      <p style={{ color: 'var(--red)', fontSize: 12 }}>
        {err}
        <br />
        <span style={{ color: 'var(--text-dim)' }}>
          This may mean the token cannot read ReplicaSets in namespace {namespace}.
        </span>
      </p>
    )
  }

  if (!rows.length) {
    return (
      <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>No revision history found.</p>
    )
  }

  return (
    <div className="rev-list">
      {rows.map((rs) => {
        const rev =
          rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || '?'
        const img = rs.spec?.template?.spec?.containers?.[0]?.image || '—'
        const ready = rs.status?.readyReplicas || 0
        const desired = rs.spec?.replicas || 0
        const isRolling = rolling === String(rev)
        return (
          <div key={rs.metadata?.uid || rev} className="rev-row">
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--accent)',
                flexShrink: 0,
              }}
            >
              Revision {rev}
            </span>
            <span className="rev-image" style={{ flex: 1, minWidth: 0 }}>
              {img}
            </span>
            <span className="rev-age">{age(rs.metadata.creationTimestamp)}</span>
            <span
              className={`pill ${ready > 0 ? 'pill-run' : 'pill-off'}`}
              style={{ flexShrink: 0 }}
            >
              {ready}/{desired}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => void rollbackTo(String(rev))}
              disabled={isRolling}
            >
              {isRolling ? '…' : 'Rollback'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
