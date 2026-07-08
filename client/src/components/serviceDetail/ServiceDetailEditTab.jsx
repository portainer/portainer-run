import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore.js'
import VibeEditTab from './VibeEditTab.jsx'

/**
 * Read GitOps annotations from a Deployment object.
 * Returns null if this deployment was not created via GitOps.
 *
 * @param {object} deployment  raw Kubernetes Deployment object
 * @returns {{ gitTargetId: string, gitBranch: string, gitPath: string, stackId?: string, deployType: string } | null}
 */
function readGitOpsAnnotations(deployment) {
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
 *
 * @param {object} props
 * @param {object} props.d deployment
 * @param {string} props.envId
 * @param {string} props.namespace
 * @param {string} props.name
 * @param {() => Promise<void> | void} props.onSaved
 */
export default function ServiceDetailEditTab({ d, envId, namespace, name, onSaved }) {
  const envPerms = useAppStore((s) => s.envPermissions)
  const perms = envPerms[`${envId}:${namespace}`] || { canEdit: true }

  const gitOpsInfo = useMemo(() => readGitOpsAnnotations(d), [d])

  if (!perms.canEdit) {
    return (
      <div style={{
        padding: '14px 18px', background: 'rgba(251,191,36,0.08)',
        border: '1px solid var(--amber)', borderRadius: 8,
        fontSize: 13, color: 'var(--amber)', fontFamily: 'var(--mono)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          width="16" height="16" style={{ flexShrink: 0 }}>
          <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
        You do not have permission to edit workloads in this environment.
      </div>
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
