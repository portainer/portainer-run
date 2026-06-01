export const ROUTES = {
  connect: '/connect',
  dashboard: '/dashboard',
  services: '/services',
  deploy: '/deploy/simple',
  deployManifest: '/deploy/manifest',
  deployVibe: '/deploy/vibe',
  catalogue: '/catalogue',
  secrets: '/secrets',
  readiness: '/readiness',
  gitTargets: '/git-targets',
}

/**
 * @param {string | number} envId
 * @param {string} namespace
 * @param {string} name
 * @param {string} [tab]
 */
export function serviceDetailPath(envId, namespace, name, tab = 'overview') {
  return `/services/${encodeURIComponent(String(envId))}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(tab)}`
}

const APP_PATHS = new Set([
  ROUTES.dashboard,
  ROUTES.services,
  ROUTES.deploy,
  ROUTES.deployManifest,
  ROUTES.deployVibe,
  '/deploy',
  ROUTES.catalogue,
  ROUTES.secrets,
  ROUTES.readiness,
  ROUTES.gitTargets,
])

/**
 * @param {unknown} p pathname from router state; rejects open redirect attacks
 * @returns {string | null}
 */
export function getSafeAppPath(p) {
  if (typeof p !== 'string' || p.length < 1) return null
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('://')) return null
  const i = p.indexOf('?')
  const pathOnly = i < 0 ? p : p.slice(0, i)
  if (APP_PATHS.has(pathOnly)) return p
  if (pathOnly.startsWith(`${ROUTES.services}/`) && !pathOnly.includes('//')) {
    const segs = pathOnly.slice(ROUTES.services.length + 1).split('/')
    if (segs.length >= 3) return p
  }
  return null
}
