import { inflightDedupe } from '../lib/inflightDedupe.js'
import { useAppStore } from '../store/useAppStore.js'

export async function loadServerConfig() {
  return inflightDedupe('server-config', async () => {
  const st = useAppStore.getState
  try {
    const r = await fetch('/config')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    st().setPortainerFromServer(!!d.portainerFromServer)
    if (d.portainerUrl && !st().portainerBaseUrl?.trim()) st().setPortainerBaseUrl(d.portainerUrl)
    st().setServerLabel(
      d.portainerUrl
        ? d.portainerUrl
        : d.portainerFromServer
          ? 'Portainer (from server .env)'
          : 'Set your Portainer base URL below'
    )
    st().setAi(!!d.aiAvailable, d.aiProvider || 'anthropic', d.baseDomain || '')
    if (d.configNamespace) st().setConfigNamespace(d.configNamespace)
    if (d.features) st().setFeatures({
      vibeDeploy:      d.features.vibeDeploy      !== false,
      simpleDeploy:    d.features.simpleDeploy    !== false,
      manifestBuilder: d.features.manifestBuilder !== false,
      catalogue:       d.features.catalogue       !== false,
      secrets:         d.features.secrets         !== false,
    })
  } catch (e) {
    st().setPortainerFromServer(false)
    st().setServerLabel('API proxy not reachable — is the portainer-run server running?')
    st().setAi(false, 'anthropic', '')
  }
  })
}
