import { useAppStore, visibleDeployments } from '../../store/useAppStore.js'

/**
 * @param {object} cfg — deploy-config JSON
 * @returns {string} markdown
 */
export function buildDeployPreview(cfg) {
  const ctrs = cfg.containers || []
  let p = `**Deployment preview: ${cfg.name || 'unnamed'}**\n\n`
  p += `**Namespace:** ${cfg.namespace || 'default'} | **Instances:** ${cfg.instances || 1}`
  if (cfg.exposure) {
    p += ` | **Exposure:** ${cfg.exposure.type}${
      cfg.exposure.ports ? ' on port ' + cfg.exposure.ports.join(', ') : ''
    }`
  }
  p += '\n\n**Containers:**\n\n'
  ctrs.forEach((ct, i) => {
    p += `- ${i === 0 ? 'Primary' : 'Sidecar'}: **${ct.name}** (${ct.image})`
    if (ct.env?.length) p += ` — ${ct.env.map((e) => e.name).join(', ')}`
    if (ct.storage) {
      p += ` — ${ct.storage.size} at ${ct.storage.mountPath} (vol: ${
        cfg.name + '-' + (ct.storage.name || ct.name + '-data')
      })`
    }
    p += '\n'
  })
  if (cfg.warnings?.length) p += '\n**Notes:** ' + cfg.warnings.join(' · ')
  return p
}

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
      d.metadata.name.toLowerCase() === tgt || t.includes(d.metadata.name.toLowerCase()),
  )
  if (!dep) return null
  return {
    serviceName: dep.metadata.name,
    envId: String(dep._envId),
    namespace: dep.metadata.namespace,
    instances: count,
  }
}
