export const ROUTES = {
  dashboard: '/dashboard',
  services: '/applications',
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
  return `/applications/${encodeURIComponent(String(envId))}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(tab)}`
}
