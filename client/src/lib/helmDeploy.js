import { serverFetch } from './api.js'

/**
 * Deploy a Helm chart via Portainer's Helm stack API.
 * Routed through the Portainer-Run server to keep the chart logic server-side.
 *
 * @param {object} p
 * @param {string} p.envId
 * @param {string} p.namespace
 * @param {string} p.releaseName
 * @param {string} p.chart
 * @param {string} p.repo
 * @param {string} p.version
 * @param {string} p.values  YAML string
 */
export async function deployHelm({ envId, namespace, releaseName, chart, repo, version, values }) {
  const res = await serverFetch('/api/helm/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envId, namespace, releaseName, chart, repo, version, values }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}
