export const ROUTES = {
  connect: '/connect',
  dashboard: '/dashboard',
  services: '/services',
  deploy: '/deploy',
  catalogue: '/catalogue',
  secrets: '/secrets',
  readiness: '/readiness',
}

const APP_PATHS = new Set([
  ROUTES.dashboard,
  ROUTES.services,
  ROUTES.deploy,
  ROUTES.catalogue,
  ROUTES.secrets,
  ROUTES.readiness,
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
  if (!APP_PATHS.has(pathOnly)) return null
  return p
}
