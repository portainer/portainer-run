import { kubeFetch } from './api.js'

/**
 * @param {string} token
 * @param {string} envId
 * @param {string} namespace
 * @param {string} name
 * @param {number} replicas
 */
export async function patchDeploymentReplicas(
  token,
  envId,
  namespace,
  name,
  replicas,
) {
  const r = Math.max(0, Math.min(100, parseInt(String(replicas), 10) || 0))
  const ns = encodeURIComponent(namespace)
  const n = encodeURIComponent(name)
  const res = await kubeFetch(
    token,
    envId,
    `/apis/apps/v1/namespaces/${ns}/deployments/${n}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
      body: JSON.stringify({ spec: { replicas: r } }),
    },
  )
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error(j?.message || 'HTTP ' + res.status)
  }
}
