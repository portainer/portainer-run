import { matchPath } from 'react-router-dom'
import { useAppStore, visibleDeployments } from '../../store/useAppStore.js'
import { ROUTES } from '../routes.js'

/**
 * @param {string} pathname
 * @returns {string} human page id
 */
function pageFromPath(pathname) {
  if (pathname === ROUTES.dashboard || pathname === '/') return 'dashboard'
  if (pathname === ROUTES.services) return 'services'
  if (pathname.startsWith(`${ROUTES.services}/`)) return 'service-detail'
  if (pathname === ROUTES.deploy) return 'deploy'
  if (pathname === ROUTES.readiness) return 'readiness'
  if (pathname === ROUTES.gitTargets) return 'git-targets'
  return 'unknown'
}

/**
 * @returns {string}
 */
export function buildAssistantContext(pathname) {
  const s = useAppStore.getState()
  const page = pageFromPath(pathname || '/')
  const envNames = s.environments.map((e) => e.Name).join(', ') || 'none'
  const deps = visibleDeployments(s)
  const depCount = deps.length
  const depNames =
    deps
      .map((d) => d.metadata.name)
      .slice(0, 20)
      .join(', ') || 'none'
  let ctx = `Current page: ${page}. Environments: ${envNames}. Managed services: ${depCount}${depCount > 0 ? ' (' + depNames + ')' : ''}.`

  const m = matchPath(
    { path: '/services/:envId/:namespace/:name', end: false },
    pathname,
  )
  if (m?.params) {
    const { envId, namespace, name } = m.params
    const envName =
      s.environments.find((e) => String(e.Id) === String(envId))?.Name || envId
    const d = deps.find(
      (x) =>
        x.metadata.name === name &&
        x.metadata.namespace === namespace &&
        String(x._envId) === String(envId),
    )
    if (d) {
      const ready = d?.status?.readyReplicas ?? 0
      const desired = d?.spec?.replicas ?? 0
      ctx += ` Viewing service "${name}" in namespace "${namespace}" on "${envName}". Status: ${ready}/${desired} instances ready.`
      const ctrs = d?.spec?.template?.spec?.containers || []
      if (ctrs.length) {
        ctx += ` Containers: ${ctrs.map((ct) => `${ct.name} (${ct.image})`).join(', ')}.`
      }
    } else {
      ctx += ` Viewing route for service "${name}" in namespace "${namespace}" on "${envName}" (full deployment data may not be in cache).`
    }
  }

  return ctx
}
