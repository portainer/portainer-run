import { useMemo } from 'react'
import VibeEditTab from './VibeEditTab.jsx'

/**
 * Read GitOps annotations from a Deployment object.
 */
function readGitOpsAnnotations(deployment) {
  if (!deployment) return null
  const ann = deployment?.metadata?.annotations || {}
  const gitTargetId = ann['portainer-run/git-target-id']
  const gitBranch = ann['portainer-run/git-branch']
  const gitPath = ann['portainer-run/git-path']
  if (!gitTargetId) return null
  return {
    gitTargetId,
    gitBranch,
    gitPath,
    stackId: ann['portainer-run/stack-id'],
    deployType: ann['portainer-run/deploy-type'] || 'simple',
  }
}

/**
 * @param {{ d: object, envId: string, namespace: string, name: string, onSaved: () => void }} props
 */
export default function ServiceDetailEditTab({ d, envId, namespace, name, onSaved }) {
  const gitOpsInfo = useMemo(() => readGitOpsAnnotations(d), [d])
  const isVibeDeploy = gitOpsInfo?.deployType === 'vibe'

  if (isVibeDeploy) {
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

  return (
    <div style={{
      padding: '24px 20px',
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      fontSize: 13,
      color: 'var(--text-dim)',
      textAlign: 'center',
    }}>
      This application was not deployed via Vibe Deploy and cannot be edited here.
    </div>
  )
}
