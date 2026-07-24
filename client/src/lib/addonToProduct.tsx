import { AddonsAddonListItem } from '@/lib/getAddons.ts'

export function addonToProduct(addon: AddonsAddonListItem) {
  return {
    id: addon.id!,
    label: addon.displayName!,
    // The app switcher is space-constrained, so prefer the short tagline;
    // fall back to the full description until the catalog serves shortDescription.
    description: addon.shortDescription ?? addon.description!,
    available: true,
    color: '#8b5cf6',
    logo: <img src={addon.icon} alt={addon.displayName} />,
    path: addon.path!,
  }
}
