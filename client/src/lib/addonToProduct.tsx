import { AddonsAddonListItem } from '@/lib/getAddons.ts'

export function addonToProduct(addon: AddonsAddonListItem) {
  return {
    id: addon.id!,
    label: addon.displayName!,
    description: addon.description!,
    available: true,
    color: '#8b5cf6',
    logo: <img src={addon.icon} alt={addon.displayName} />,
  }
}
