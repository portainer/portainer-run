import { kubeFetch } from '../lib/api.js'
import { refreshCache } from './refreshDeployments.js'
import { deleteAppPaths } from '../lib/gitTargets.js'
import { useAppStore } from '../store/useAppStore.js'

/** Stable key for an app's in-flight delete state. */
export function appDeleteKey(envId, ns, name) {
  return `${envId}:${ns}:${name}`
}

/**
 * Delete a deployment and its associated resources. Awaited by the confirm
 * modal, which stays open with a progress indicator until this resolves
 * (issue #44). Progress is also tracked in the store under deletingApps keyed
 * by app, as a guard against a duplicate delete of the same app.
 *
 * @param {object} target  { envId, ns, name, gitTargetId?, gitBranch?, gitPath?, vibeSourcePath? }
 * @param {object} [opts]
 * @param {boolean} [opts.deleteManifest]  also remove GitOps manifest/source from git
 * @returns {Promise<boolean>}  true if the deployment was deleted, false on failure
 */
export async function deleteApp(target, { deleteManifest = false } = {}) {
  const { envId, ns, name, gitTargetId, gitBranch, gitPath, vibeSourcePath } =
    target
  const isVibeDeploy = Boolean(vibeSourcePath)
  const isGitOps = Boolean(gitTargetId && gitBranch && gitPath)

  const st = useAppStore.getState
  const token = st().token
  const key = appDeleteKey(envId, ns, name)

  // Guard against re-triggering a delete already in flight for the same app.
  if (st().deletingApps[key]) return false
  st().markAppDeleting(key)

  try {
    // 1. Read Deployment first so we can find all PVC names from spec.volumes
    let pvcNames = [name] // fallback: assume PVC shares the deployment name
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
      /* non-fatal — fall through to name-based fallback */
    }

    // 2. Delete the git credentials Secret if this is a Vibe Deploy app (best-effort)
    if (isVibeDeploy) {
      await kubeFetch(
        token,
        envId,
        `/api/v1/namespaces/${ns}/secrets/${name}-git-credentials`,
        { method: 'DELETE' },
      ).catch(() => {})
      // App secrets Secret, if one was created for sensitive env vars (issue #38)
      await kubeFetch(
        token,
        envId,
        `/api/v1/namespaces/${ns}/secrets/${name}-app-secrets`,
        { method: 'DELETE' },
      ).catch(() => {})
    }

    // 3. Delete the Kubernetes Deployment
    const r = await kubeFetch(
      token,
      envId,
      `/apis/apps/v1/namespaces/${ns}/deployments/${name}`,
      {
        method: 'DELETE',
      },
    )
    if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status)

    // 4. Delete associated resources — best-effort, 404s silently ignored
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

    // 5. Optionally delete git entries — manifest file and source directory
    //    removed in a SINGLE commit to avoid a non-fast-forward race between
    //    two sequential commits against the same branch.
    if (isGitOps && deleteManifest) {
      try {
        const paths = [gitPath]
        if (isVibeDeploy && vibeSourcePath) paths.push(vibeSourcePath)
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
