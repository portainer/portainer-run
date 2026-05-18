import { matchPath } from 'react-router-dom'
import { ROUTES, serviceDetailPath } from './routes.js'

/** Tab segment labels (must match ServiceDetailPage TABS). */
export const SERVICE_TAB_LABELS = {
  overview: 'Overview',
  containers: 'Containers',
  metrics: 'Metrics',
  logs: 'Logs',
  revisions: 'Revisions',
  edit: 'Edit',
}

/**
 * @typedef {{ label: string, to?: string, current?: boolean }} BreadcrumbItem
 */

/**
 * @param {string} pathname
 * @returns {BreadcrumbItem[]}
 */
export function getBreadcrumbItems(pathname) {
  const path = (pathname || '/').replace(/\/$/, '') || '/'

  if (path === '/dashboard' || path === '/') {
    return []
  }

  if (path === ROUTES.services) {
    return [{ label: 'Services', current: true }]
  }

  const serviceMatch = matchPath(
    { path: '/services/:envId/:namespace/:name/:tab', end: true },
    path,
  )
  if (serviceMatch) {
    const { envId, namespace, name, tab } = serviceMatch.params
    const tabKey = tab || 'overview'
    const tabLabel = SERVICE_TAB_LABELS[tabKey] || tabKey
    if (tabKey === 'overview') {
      return [
        { label: 'Services', to: ROUTES.services },
        { label: name, current: true },
      ]
    }
    return [
      { label: 'Services', to: ROUTES.services },
      { label: name, to: serviceDetailPath(envId, namespace, name, 'overview') },
      { label: tabLabel, current: true },
    ]
  }

  if (path === ROUTES.deploy) {
    return [{ label: 'Deploy', current: true }]
  }

  if (path === ROUTES.catalogue) {
    return [{ label: 'Catalogue', current: true }]
  }

  if (path === ROUTES.secrets) {
    return [{ label: 'Secrets', current: true }]
  }

  if (path === ROUTES.readiness) {
    return [{ label: 'Cluster Readiness', current: true }]
  }

  if (path === ROUTES.gitTargets) {
    return [{ label: 'Git Targets', current: true }]
  }

  return [{ label: 'App', current: true }]
}
