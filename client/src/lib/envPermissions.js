import { kubeFetch } from './api.js'

/**
 * Check what actions the current user can perform in a given environment+namespace
 * using Kubernetes SelfSubjectAccessReview.
 *
 * Namespace-scoped — only fires once both envId AND namespace are known.
 * Failures default to true (permissive) so a network error never locks users out.
 *
 * @param {string} token
 * @param {string|number} envId
 * @param {string} namespace
 * @returns {Promise<{ canDeploy: boolean, canEdit: boolean, canDelete: boolean, canRestart: boolean, canViewLogs: boolean, canCreatePvc: boolean, canCreateSecret: boolean, canDeleteSecret: boolean }>}
 */
export async function checkEnvPermissions(token, envId, namespace) {
  const defaults = {
    canDeploy: true,
    canEdit: true,
    canDelete: true,
    canRestart: true,
    canViewLogs: true,
    canCreatePvc: true,
    canCreateSecret: true,
    canDeleteSecret: true,
  }
  if (!token || !envId || !namespace) return defaults

  try {
    const checks = [
      {
        key: 'canDeploy',
        verb: 'create',
        resource: 'deployments',
        group: 'apps',
      },
      {
        key: 'canEdit',
        verb: 'update',
        resource: 'deployments',
        group: 'apps',
      },
      {
        key: 'canDelete',
        verb: 'delete',
        resource: 'deployments',
        group: 'apps',
      },
      { key: 'canRestart', verb: 'create', resource: 'pods/exec', group: '' },
      { key: 'canViewLogs', verb: 'get', resource: 'pods/log', group: '' },
      {
        key: 'canCreatePvc',
        verb: 'create',
        resource: 'persistentvolumeclaims',
        group: '',
      },
      {
        key: 'canCreateSecret',
        verb: 'create',
        resource: 'secrets',
        group: '',
      },
      {
        key: 'canDeleteSecret',
        verb: 'delete',
        resource: 'secrets',
        group: '',
      },
    ]

    const results = await Promise.all(
      checks.map(async ({ key, verb, resource, group }) => {
        try {
          const body = JSON.stringify({
            apiVersion: 'authorization.k8s.io/v1',
            kind: 'SelfSubjectAccessReview',
            spec: {
              resourceAttributes: { verb, resource, group, namespace },
            },
          })
          const r = await kubeFetch(
            token,
            envId,
            '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
            {
              method: 'POST',
              body,
              headers: { 'Content-Type': 'application/json' },
            },
          )
          if (!r.ok) return { key, allowed: true }
          const data = await r.json()
          return { key, allowed: Boolean(data?.status?.allowed) }
        } catch {
          return { key, allowed: true }
        }
      }),
    )

    const perms = { ...defaults }
    for (const { key, allowed } of results) perms[key] = allowed
    return perms
  } catch {
    return defaults
  }
}
