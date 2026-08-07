export const ROUTES = {
  dashboard: '/dashboard',
  services: '/applications',
  deploy: '/deploy/vibe',
  readiness: '/readiness',
  gitTargets: '/git-targets',
  settings: '/settings',
  setup: '/setup',
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

/**
 * Root of an app's detail page (no specific tab) — redirects to the default tab.
 * Used by favorites so a saved app opens at its root rather than a pinned tab.
 * @param {string | number} envId
 * @param {string} namespace
 * @param {string} name
 */
export function serviceDetailRootPath(envId, namespace, name) {
  return `/applications/${encodeURIComponent(String(envId))}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
}
