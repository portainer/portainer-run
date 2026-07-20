import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@ds/v3-components/Button/Button'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from '@ds/v3-components/Dialog/Dialog'
import { FormControl, Input } from '@ds/v3-components/FormField/FormField'
import { Select } from '@ds/v3-components/Select/Select'

import { useAppStore } from '../../store/useAppStore.js'
import { serviceDetailPath } from '../../lib/routes.js'
import { kubeFetch } from '../../lib/api.js'
import { refreshCache } from '../../services/refreshDeployments.js'
import { loadDeployFormFromCluster } from '../../lib/deployFormLoadFromCluster.js'
import {
  buildK8sContainer,
  executeDeploy,
  fetchNamespaceOptions,
  readVolumeDefForDeploy,
} from '../../lib/deployK8s.js'
import { withDefaultCnames } from '../../lib/deployFormModel.js'
import { MONO_FONT } from './detailUi'
import { errMessage } from '../../lib/errors'

/** Deploy-form container model produced by the JS deploy pipeline. */
interface DeployFormContainer {
  id: string
  [key: string]: unknown
}

interface MigrateDialogProps {
  open: boolean
  onClose: () => void
  token: string
  /** Source environment/namespace/app being migrated. */
  envId: string
  namespace: string
  name: string
  visEnvs: { Id: number; Name: string }[]
}

/**
 * Clone or move a deployment to another environment/namespace. Self-contained:
 * owns all target-selection state and the clone/move pipeline.
 */
export function MigrateDialog({
  open,
  onClose,
  token,
  envId,
  namespace,
  name,
  visEnvs,
}: MigrateDialogProps) {
  const navigate = useNavigate()
  const pushToast = useAppStore((s) => s.pushToast)

  const [migrateEnvId, setMigrateEnvId] = useState(String(envId || ''))
  const [migrateNamespace, setMigrateNamespace] = useState('')
  const [migrateManualNs, setMigrateManualNs] = useState(false)
  const [migrateManualNsValue, setMigrateManualNsValue] = useState(namespace || '')
  const [migrateNsList, setMigrateNsList] = useState<string[]>([])
  const [migrateNsLoading, setMigrateNsLoading] = useState(false)
  const [migrateNsStatus, setMigrateNsStatus] = useState<{
    text: string
    tone: string
  }>({ text: '', tone: 'dim' })
  const [migratePending, setMigratePending] = useState(false)

  // Reset target selection each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setMigrateEnvId(String(envId || ''))
    setMigrateNamespace('')
    setMigrateManualNs(false)
    setMigrateManualNsValue(namespace || '')
    setMigrateNsList([])
    setMigrateNsStatus({ text: '', tone: 'dim' })
  }, [open, envId, namespace])

  const loadMigrateNamespaces = useCallback(
    async (targetEnv: string) => {
      if (!targetEnv || !token) {
        setMigrateNsLoading(false)
        setMigrateNsList([])
        setMigrateManualNs(false)
        setMigrateNamespace('')
        setMigrateNsStatus({ text: '', tone: 'dim' })
        return
      }
      setMigrateNsLoading(true)
      setMigrateNsStatus({ text: 'Loading…', tone: 'dim' })
      try {
        const r = await fetchNamespaceOptions(token, targetEnv)
        if (r.ok && r.manual) {
          setMigrateNsList([])
          setMigrateManualNs(true)
          setMigrateNamespace('')
          setMigrateNsStatus({
            text: r.message || 'Token is namespace-scoped — enter manually.',
            tone: 'amber',
          })
        } else if (r.ok) {
          const list = r.namespaces || []
          setMigrateNsList(list)
          setMigrateManualNs(false)
          setMigrateNamespace(list[0] || '')
          setMigrateNsStatus({
            text: r.message || `${list.length} namespace(s)`,
            tone: 'green',
          })
        } else {
          setMigrateNsList([])
          setMigrateManualNs(true)
          setMigrateNamespace('')
          setMigrateNsStatus({
            text: r.error || 'Failed to fetch namespaces',
            tone: 'red',
          })
        }
      } catch (e: unknown) {
        setMigrateNsList([])
        setMigrateManualNs(true)
        setMigrateNamespace('')
        setMigrateNsStatus({
          text: errMessage(e) || 'Error loading namespaces',
          tone: 'red',
        })
      } finally {
        setMigrateNsLoading(false)
      }
    },
    [token],
  )

  useEffect(() => {
    if (!open) return
    void loadMigrateNamespaces(migrateEnvId)
  }, [open, migrateEnvId, loadMigrateNamespaces])

  const runMigrate = useCallback(
    async (mode: 'clone' | 'move') => {
      if (!token || !envId || !namespace || !name) return
      const targetEnv = String(migrateEnvId || '').trim()
      const targetNs = String(
        migrateManualNs ? migrateManualNsValue : migrateNamespace || '',
      ).trim()
      if (!targetEnv) {
        pushToast('Pick a target environment', 'err')
        return
      }
      if (!targetNs) {
        pushToast('Enter a target namespace', 'err')
        return
      }
      if (targetEnv === String(envId) && targetNs === namespace) {
        pushToast('Pick a different environment and/or namespace', 'err')
        return
      }
      setMigratePending(true)
      try {
        const loaded = await loadDeployFormFromCluster(
          token,
          String(envId),
          namespace,
          name,
        )
        const forBuild: DeployFormContainer[] = withDefaultCnames(
          loaded.containers || [],
        )
        const pairs = forBuild
          .map((c) => {
            const spec = buildK8sContainer(c)
            return spec ? { id: c.id, spec } : null
          })
          .filter((p): p is { id: string; spec: object } => p !== null)
        if (!pairs.length) throw new Error('No containers found to migrate')
        const volDefs = forBuild
          .map((c) => readVolumeDefForDeploy(c))
          .filter((v): v is NonNullable<typeof v> => v !== null)
        const servicePorts = (loaded.svcPorts || [])
          .map((p: unknown) => parseInt(String(p), 10))
          .filter((n: number) => n > 0)
        const deployOptions = {
          envId: targetEnv,
          ns: targetNs,
          appName: name,
          instances: Math.max(
            0,
            Math.min(100, parseInt(String(loaded.instances), 10) || 1),
          ),
          containerSpecs: pairs.map((p) => p.spec),
          containerRowIds: pairs.map((p) => p.id),
          volumeDefs: volDefs,
          exposeType: loaded.exposeType || 'none',
          servicePorts,
          ingress: {
            host: (loaded.ingHost || '').trim(),
            path: (loaded.ingPath || '/').trim() || '/',
            port: loaded.ingPort || 80,
            ingressClass: (loaded.ingClass || '').trim(),
          },
        }
        await executeDeploy(token, deployOptions)
        if (mode === 'move') {
          const del = await kubeFetch(
            token,
            String(envId),
            `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
            { method: 'DELETE' },
          )
          if (!del.ok && del.status !== 404) {
            throw new Error(
              'Cloned successfully, but delete failed (HTTP ' + del.status + ')',
            )
          }
        }
        onClose()
        await refreshCache(false)
        pushToast(
          mode === 'move'
            ? `Moved “${name}” to ${targetNs} on ${targetEnv}`
            : `Cloned “${name}” to ${targetNs} on ${targetEnv}`,
          'ok',
        )
        if (mode === 'move') {
          navigate(serviceDetailPath(targetEnv, targetNs, name, 'overview'), {
            replace: true,
          })
        }
      } catch (e: unknown) {
        pushToast(
          (mode === 'move' ? 'Move' : 'Clone') + ' failed: ' + errMessage(e),
          'err',
        )
      } finally {
        setMigratePending(false)
      }
    },
    [
      token,
      envId,
      namespace,
      name,
      migrateEnvId,
      migrateNamespace,
      migrateManualNs,
      migrateManualNsValue,
      pushToast,
      navigate,
      onClose,
    ],
  )

  return (
    <Dialog open={open} onClose={onClose} width={480}>
      <DialogHeader title="Migrate stack" onClose={onClose} />
      <DialogBody>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            You can <strong>clone</strong> this stack to a new location, or{' '}
            <strong>move</strong> it. Moving may have downtime because the source
            deployment is removed after the target is created.
          </div>
          <FormControl label="Target environment">
            <Select
              value={migrateEnvId}
              onChange={(e) => {
                setMigrateEnvId(e.target.value)
                setMigrateNamespace('')
                setMigrateNsList([])
                setMigrateNsStatus({ text: '', tone: 'dim' })
              }}
              disabled={migratePending}
              options={[
                { value: '', label: '— Select —' },
                ...visEnvs.map((e) => ({
                  value: String(e.Id),
                  label: e.Name,
                })),
              ]}
            />
          </FormControl>
          <FormControl label="Target namespace">
            {migrateManualNs ? (
              <Input
                type="text"
                value={migrateManualNsValue}
                onChange={(e) => setMigrateManualNsValue(e.target.value)}
                placeholder="production"
                disabled={migratePending || migrateNsLoading}
              />
            ) : (
              <Select
                value={migrateNamespace}
                onChange={(e) => setMigrateNamespace(e.target.value)}
                disabled={!migrateEnvId || migratePending || migrateNsLoading}
                options={[
                  {
                    value: '',
                    label: !migrateEnvId
                      ? 'Select target first...'
                      : migrateNsLoading
                        ? 'Loading namespaces...'
                        : '— Select —',
                  },
                  ...migrateNsList.map((n) => ({ value: n, label: n })),
                ]}
              />
            )}
            <div
              style={{
                fontFamily: MONO_FONT,
                fontSize: 12,
                color:
                  migrateNsStatus.tone === 'amber'
                    ? 'var(--status-warning, #f79009)'
                    : migrateNsStatus.tone === 'green'
                      ? 'var(--status-success, #12b76a)'
                      : migrateNsStatus.tone === 'red'
                        ? 'var(--status-danger, #f04438)'
                        : 'var(--muted)',
                marginTop: 4,
              }}
            >
              {migrateNsStatus.text}
            </div>
          </FormControl>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={migratePending}>
          Cancel
        </Button>
        <Button onClick={() => void runMigrate('clone')} disabled={migratePending}>
          {migratePending ? 'Working…' : 'Clone'}
        </Button>
        <Button
          color="danger"
          onClick={() => void runMigrate('move')}
          disabled={migratePending}
        >
          {migratePending ? 'Working…' : 'Move'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
