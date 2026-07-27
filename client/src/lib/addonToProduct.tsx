import type { ApplicationSwitcherProduct } from '@ds/v3-templates/ApplicationSwitcher/ApplicationSwitcher.tsx'
import { AddonsAddonListItem } from '@/lib/getAddons.ts'

/** An app-switcher entry, plus where selecting it navigates to. */
export type SwitcherProduct = ApplicationSwitcherProduct & { path: string }

export function addonToProduct(addon: AddonsAddonListItem): SwitcherProduct {
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
