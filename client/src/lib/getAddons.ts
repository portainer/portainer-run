import { addonToProduct } from '@/lib/addonToProduct.tsx'
import { apiFetch } from '@/lib/api'

export type AddonsAddonListItem = {
  description?: string
  displayName?: string
  healthMessage?: string
  healthStatus?: AddonHealthStatus
  icon?: string
  id?: string
  lifecycleStatus?: AddonLifecycleStatus
  lifecycleStatusMessage?: string
  path?: string
  record?: { enabled: boolean }
}

export const AddonHealthStatus = {
  ADDON_HEALTH_UNKNOWN: 'unknown',
  ADDON_HEALTH_HEALTHY: 'healthy',
  ADDON_HEALTH_UNHEALTHY: 'unhealthy',
} as const

export type AddonHealthStatus =
  (typeof AddonHealthStatus)[keyof typeof AddonHealthStatus]

export const AddonLifecycleStatus = {
  ADDON_STATUS_INSTALLING: 'installing',
  ADDON_STATUS_UPGRADING: 'upgrading',
  ADDON_STATUS_INSTALLED: 'installed',
  ADDON_STATUS_FAILED: 'failed',
  ADDON_STATUS_UNKNOWN: 'unknown',
  ADDON_STATUS_UNINSTALLING: 'uninstalling',
} as const

export type AddonLifecycleStatus =
  (typeof AddonLifecycleStatus)[keyof typeof AddonLifecycleStatus]

export function getAddons() {
  return apiFetch(null, '/addons')
    .then((response) => response.json())
    .then((response) => {
      return (response.addons ?? [])
        .filter((a: AddonsAddonListItem) => a.id !== 'portainer-run')
        .map(addonToProduct)
    })
}
