import { useAppStore, visibleDeployments } from '../../store/useAppStore.js'

/**
 * @param {string} text
 * @returns {null | { serviceName: string, envId: string, namespace: string, instances: number }}
 */
export function parseScaleAction(text) {
  const m = text.match(
    /scale\s+["']?([\w-]+)["']?\s+(?:(?:down|up)\s+to|to)\s+(\d+)/i,
  )
  if (!m) return null
  const tgt = m[1].toLowerCase()
  const count = Math.min(100, Math.max(0, parseInt(m[2], 10) || 0))
  const t = text.toLowerCase()
  const deps = visibleDeployments(useAppStore.getState())
  const dep = deps.find(
    (d) =>
      d.metadata.name.toLowerCase() === tgt ||
      t.includes(d.metadata.name.toLowerCase()),
  )
  if (!dep) return null
  return {
    serviceName: dep.metadata.name,
    envId: String(dep._envId),
    namespace: dep.metadata.namespace,
    instances: count,
  }
}
