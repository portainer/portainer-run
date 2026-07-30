import { kubeFetch } from '../lib/api.js'
import { refreshCache } from './refreshDeployments.js'
import { deleteAppPaths, deleteAppStack } from '../lib/gitTargets.js'
import { useAppStore } from '../store/useAppStore.js'

/** Stable key for an app's in-flight delete state. */
export function appDeleteKey(envId, ns, name) {
  return `${envId}:${ns}:${name}`
}

/**
 * Label Portainer stamps on every resource it deploys through a stack. It is
 * the authoritative link from a resource back to its owning stack, which makes
 * a Portainer-Run-written annotation unnecessary — and means this works for apps
 * deployed before this code existed.
 */
export const STACK_ID_LABEL = 'io.portainer.kubernetes.application.stackid'

/**
 * Resources the deploy flow creates directly through the Kubernetes API rather
 * than declaring in the committed manifest, so that a git token never reaches
 * the repository (see server/routes/vibe.js). Stack teardown cannot know about
 * them, so they are cleaned up here.
 */
function unmanagedSecretNames(name) {
  return [`${name}-git-credentials`, `${name}-app-secrets`]
}

/**
 * Delete every Kubernetes resource declared in an app's manifest, one by one.
 *
 * Only used for apps with no owning stack (deployed outside the stack flow, or
 * a stack deleted out from under them). Where a stack exists, Portainer's own
 * teardown does this, and doing it here as well would race its reconciliation.
 */
async function deleteResourcesDirectly(token, envId, ns, name) {
  // Read the Deployment first so PVCs are discovered from the pod spec rather
  // than guessed from the app name.
  let pvcNames = [`${name}-data`] // matches the deploy flow's PVC convention
  try {
    const depRes = await kubeFetch(
      token,
      envId,
      `/apis/apps/v1/namespaces/${ns}/deployments/${name}`,
    )
    if (depRes.ok) {
      const dep = await depRes.json()
      const vols = dep?.spec?.template?.spec?.volumes || []
      const fromSpec = vols
        .filter((v) => v.persistentVolumeClaim?.claimName)
        .map((v) => v.persistentVolumeClaim.claimName)
      if (fromSpec.length > 0) pvcNames = fromSpec
    }
  } catch {
    /* non-fatal — fall through to the name-based fallback */
  }

  const r = await kubeFetch(
    token,
    envId,
    `/apis/apps/v1/namespaces/${ns}/deployments/${name}`,
    { method: 'DELETE' },
  )
  if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status)

  // Best-effort; 404s are expected for resources this app never had.
  await Promise.allSettled([
    kubeFetch(token, envId, `/api/v1/namespaces/${ns}/services/${name}`, {
      method: 'DELETE',
    }),
    kubeFetch(
      token,
      envId,
      `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${name}`,
      { method: 'DELETE' },
    ),
    ...pvcNames.map((pvcName) =>
      kubeFetch(
        token,
        envId,
        `/api/v1/namespaces/${ns}/persistentvolumeclaims/${pvcName}`,
        { method: 'DELETE' },
      ),
    ),
  ])
}

/**
 * Delete an app and its associated resources. Awaited by the confirm modal,
 * which stays open with a progress indicator until this resolves (issue #44).
 * Progress is also tracked in the store under deletingApps keyed by app, as a
 * guard against a duplicate delete of the same app.
 *
 * Where the app has an owning Portainer stack, that stack is deleted and its
 * teardown removes the manifest's resources. Deleting the resources without the
 * stack used to leave the stack record polling git: because the poll compares
 * the branch head against the stack's last deployed commit, and every app
 * shares one manifests branch, the next deploy of any other app moved that head
 * and the orphaned stack re-applied the deleted app's manifest.
 *
 * @param {object} target  { envId, ns, name, stackId?, gitTargetId?, gitBranch?, gitPath?, vibeSourcePath? }
 * @param {object} [opts]
 * @param {boolean} [opts.deleteManifest]  also remove GitOps manifest/source from git
 * @returns {Promise<boolean>}  true if the app was deleted, false on failure
 */
export async function deleteApp(target, { deleteManifest = false } = {}) {
  const {
    envId,
    ns,
    name,
    stackId,
    gitTargetId,
    gitBranch,
    gitPath,
    vibeSourcePath,
  } = target
  const isGitOps = Boolean(gitTargetId && gitBranch && gitPath)

  const st = useAppStore.getState
  const token = st().token
  const key = appDeleteKey(envId, ns, name)

  // Guard against re-triggering a delete already in flight for the same app.
  if (st().deletingApps[key]) return false
  st().markAppDeleting(key)

  try {
    // 1. Remove the owning stack first, so its auto-update poll cannot race the
    //    cleanup and re-apply what we are deleting.
    if (stackId) {
      await deleteAppStack({ envId, stackId })
    } else {
      await deleteResourcesDirectly(token, envId, ns, name)
    }

    // 2. Secrets are created directly against the Kubernetes API and never
    //    committed, so no stack owns them. Best-effort — an app without
    //    sensitive env vars or a git source has neither.
    await Promise.allSettled(
      unmanagedSecretNames(name).map((secretName) =>
        kubeFetch(
          token,
          envId,
          `/api/v1/namespaces/${ns}/secrets/${secretName}`,
          { method: 'DELETE' },
        ),
      ),
    )

    // 3. Optionally delete git entries — manifest file and source directory
    //    removed in a SINGLE commit to avoid a non-fast-forward race between
    //    two sequential commits against the same branch.
    if (isGitOps && deleteManifest) {
      try {
        const paths = [gitPath]
        if (vibeSourcePath) paths.push(vibeSourcePath)
        await deleteAppPaths({
          gitTargetId,
          branch: gitBranch,
          paths,
          appName: name,
        })
      } catch (e) {
        st().pushToast(
          `Deployment deleted but Git cleanup failed: ${e?.message || 'unknown error'} — check the token has write access to the repository`,
          'warn',
        )
      }
    }

    st().pushToast(`Deployment "${name}" deleted`, 'ok')
    await refreshCache(false)
    return true
  } catch (e) {
    st().pushToast(`Delete failed for "${name}": ` + (e?.message || e), 'err')
    return false
  } finally {
    st().clearAppDeleting(key)
  }
}
