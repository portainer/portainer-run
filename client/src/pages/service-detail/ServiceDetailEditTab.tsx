import { useMemo } from 'react'

import { Alert } from '@ds/v3-components/Alert/Alert'

import { useAppStore } from '../../store/useAppStore.js'
import { VibeEditTab } from './VibeEditTab'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Read GitOps annotations from a Deployment object.
 * Returns null if this deployment was not created via GitOps.
 */
function readGitOpsAnnotations(deployment: any) {
  const ann = deployment?.metadata?.annotations || {}
  const gitTargetId = ann['portainer-run/git-target-id']
  const gitBranch = ann['portainer-run/git-branch']
  const gitPath = ann['portainer-run/git-path']
  if (!gitTargetId || !gitBranch || !gitPath) return null
  return {
    gitTargetId,
    gitBranch,
    gitPath,
    stackId: ann['portainer-run/stack-id'],
    deployType: ann['portainer-run/deploy-type'] || 'vibe',
  }
}

/**
 * Edit tab for a deployed application. Every application is deployed through
 * the Deploy path, so editing is handled by the dedicated Deploy edit tab.
 */
export function ServiceDetailEditTab({
  d,
  envId,
  namespace,
  name,
  onSaved,
}: {
  d: any
  envId: string
  namespace: string
  name: string
  onSaved: () => Promise<void> | void
}) {
  const envPerms = useAppStore((s) => s.envPermissions)
  const perms = envPerms[`${envId}:${namespace}`] || { canEdit: true }

  const gitOpsInfo = useMemo(() => readGitOpsAnnotations(d), [d])

  if (!perms.canEdit) {
    return (
      <Alert
        tone="warning"
        title="You do not have permission to edit workloads in this environment."
      />
    )
  }

  return (
    <VibeEditTab
      d={d}
      envId={envId}
      namespace={namespace}
      name={name}
      gitOpsInfo={gitOpsInfo}
      onSaved={onSaved}
    />
  )
}
