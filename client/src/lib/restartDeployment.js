import { kubeFetch } from './api.js'

/**
 * Rollout restart: patch deployment template annotation (kubectl rollout undo style trigger).
 * @returns {Promise<object | null>} updated deployment body when JSON parse succeeds
 */
export async function restartDeployment(token, envId, namespace, name) {
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
          },
        },
      },
    },
  }
  const ns = encodeURIComponent(namespace)
  const n = encodeURIComponent(name)
  const r = await kubeFetch(
    token,
    envId,
    `/apis/apps/v1/namespaces/${ns}/deployments/${n}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
      body: JSON.stringify(patch),
    },
  )
  if (!r.ok) {
    let message = 'HTTP ' + r.status
    try {
      const j = await r.json()
      message = j?.message || message
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return r.json().catch(() => null)
}
