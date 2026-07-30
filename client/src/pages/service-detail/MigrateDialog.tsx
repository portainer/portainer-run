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
import { refreshCache } from '../../services/refreshDeployments.js'
import { fetchNamespaceOptions } from '../../lib/deployK8s.js'
import { getGitTarget, migrateApp } from '../../lib/gitTargets.js'
import { STACK_ID_LABEL } from '../../services/deleteApp.js'
import { MONO_FONT } from './detailUi'
import { errMessage } from '../../lib/errors'
import type { Deployment } from '../../types/k8s'

interface MigrateDialogProps {
  open: boolean
  onClose: () => void
  token: string
  /** Source environment/namespace/app being migrated. */
  envId: string
  namespace: string
  name: string
  visEnvs: { Id: number; Name: string }[]
  /**
   * The source app's live Deployment. Migrate reads its GitOps annotations and
   * Portainer's stack-id label from here, so it can recreate the app as a stack
   * rather than as loose Kubernetes resources.
   */
  deployment: Deployment | null
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
  deployment,
}: MigrateDialogProps) {
  const navigate = useNavigate()
  const pushToast = useAppStore((s) => s.pushToast)

  const ann = deployment?.metadata?.annotations || {}
  const gitTargetId = ann['portainer-run/git-target-id'] || ''
  const gitBranch = ann['portainer-run/git-branch'] || ''
  const gitPath = ann['portainer-run/git-path'] || ''
  const vibeSourcePath = ann['portainer-run/vibe-source-path'] || null
  const stackId = deployment?.metadata?.labels?.[STACK_ID_LABEL] || null
  // Only GitOps-deployed apps can be migrated as stacks. Anything else has no
  // manifest to copy, so there is nothing to recreate in the target.
  const canMigrate = Boolean(gitTargetId && gitBranch && gitPath)

  const [migrateEnvId, setMigrateEnvId] = useState(String(envId || ''))
  const [migrateNamespace, setMigrateNamespace] = useState('')
  const [migrateManualNs, setMigrateManualNs] = useState(false)
  const [migrateManualNsValue, setMigrateManualNsValue] = useState(
    namespace || '',
  )
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
      if (!canMigrate) {
        pushToast(
          'This app has no GitOps manifest, so it cannot be migrated',
          'err',
        )
        return
      }
      setMigratePending(true)
      try {
        // The manifest path is built from the git target's configured prefix, the
        // same way the deploy flow builds it.
        const targetName =
          visEnvs.find((e) => String(e.Id) === targetEnv)?.Name || targetEnv
        let pathPrefix = ''
        try {
          const t = (await getGitTarget(gitTargetId)) as {
            connection?: { payload?: { pathPrefix?: string } }
          }
          pathPrefix = t?.connection?.payload?.pathPrefix || ''
        } catch {
          /* non-fatal — an empty prefix matches the default deploy layout */
        }

        await migrateApp({
          mode,
          gitTargetId,
          branch: gitBranch,
          pathPrefix,
          pollInterval: '5m',
          source: {
            envId: String(envId),
            ns: namespace,
            appName: name,
            gitPath,
            vibeSourcePath,
            stackId,
          },
          target: { envId: targetEnv, envName: targetName, ns: targetNs },
        })
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
      canMigrate,
      gitTargetId,
      gitBranch,
      gitPath,
      vibeSourcePath,
      stackId,
      visEnvs,
    ],
  )

  return (
    <Dialog open={open} onClose={onClose} width={480}>
      <DialogHeader title="Migrate stack" onClose={onClose} />
      <DialogBody>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            You can <strong>clone</strong> this stack to a new location, or{' '}
            <strong>move</strong> it. Either way the app is recreated as a stack
            in the target, with its own copy of the source. Moving removes the
            source stack and its Git entries once the target exists, so there
            may be downtime.
          </div>
          {!canMigrate && (
            <div
              style={{
                fontSize: 13,
                color: 'var(--status-danger, #f04438)',
              }}
            >
              This app has no GitOps manifest, so there is nothing to recreate
              in the target. Migrate is only available for apps deployed through
              the Deploy flow.
            </div>
          )}
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
        <Button
          onClick={() => void runMigrate('clone')}
          disabled={migratePending || !canMigrate}
        >
          {migratePending ? 'Working…' : 'Clone'}
        </Button>
        <Button
          color="danger"
          onClick={() => void runMigrate('move')}
          disabled={migratePending || !canMigrate}
        >
          {migratePending ? 'Working…' : 'Move'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
