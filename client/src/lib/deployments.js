import { kubeFetch } from './api.js'
import { fetchNamespaceOptions } from './deployK8s.js'

const LABEL = encodeURIComponent('managed-by=portainer-run')

function tagEnv(items, env) {
  for (const d of items) {
    d._envId = env.Id
    d._envName = env.Name
  }
  return items
}

/**
 * Fetch portainer-run managed deployments for an environment.
 *
 * Admins have cluster-scoped RBAC, so a single cluster-wide list call works.
 * Standard users have no cluster scope, so we fetch per namespace, scoped to
 * the namespaces Portainer reports the user can access.
 *
 * @param {string} token
 * @param {object} env Portainer environment { Id, Name }
 * @param {boolean} isAdmin
 * @returns {Promise<object[]>}
 */
export async function fetchEnvDeployments(token, env, isAdmin) {
  try {
    if (isAdmin) {
      const r = await kubeFetch(
        token,
        env.Id,
        `/apis/apps/v1/deployments?labelSelector=${LABEL}`,
      )
      if (!r.ok) return []
      return tagEnv((await r.json()).items || [], env)
    }
    return await fetchPerNamespace(token, env)
  } catch {
    return []
  }
}

/**
 * Per-namespace fetch for standard users, scoped to the namespaces Portainer
 * reports the user can access.
 *
 * @param {string} token
 * @param {object} env Portainer environment { Id, Name }
 * @returns {Promise<object[]>}
 */
async function fetchPerNamespace(token, env) {
  const { namespaces = [] } = await fetchNamespaceOptions(token, env.Id)
  const results = await Promise.all(
    namespaces.map(async (ns) => {
      try {
        const r = await kubeFetch(
          token,
          env.Id,
          `/apis/apps/v1/namespaces/${ns}/deployments?labelSelector=${LABEL}`,
        )
        if (!r.ok) return []
        return (await r.json()).items || []
      } catch {
        return []
      }
    }),
  )
  return tagEnv(results.flat(), env)
}
