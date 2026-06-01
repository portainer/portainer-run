import { useAppStore } from '../store/useAppStore.js'

function serverHeaders() {
  const { portainerBaseUrl, portainerFromServer, token } = useAppStore.getState()
  const h = { 'Content-Type': 'application/json' }
  if (token) h['X-API-Key'] = token
  const u = (portainerBaseUrl || '').trim()
  if (u && !portainerFromServer) h['X-Portainer-URL'] = u
  return h
}

/**
 * Deploy a Helm chart via Portainer's Helm stack API.
 * Routed through the Portainer Run server to keep the token server-side.
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
  const res = await fetch('/api/helm/deploy', {
    method: 'POST',
    headers: serverHeaders(),
    body: JSON.stringify({ envId, namespace, releaseName, chart, repo, version, values }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}
