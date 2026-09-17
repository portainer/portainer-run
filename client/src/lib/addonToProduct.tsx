import type { ApplicationSwitcherProduct } from '@ds/v3-templates/ApplicationSwitcher/ApplicationSwitcher.tsx'
import type { AddonsAddonListItem } from '@/lib/getAddons.ts'

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
    // An add-on declares its own icon path, which may be absent or may 404
    // under whatever base path it is mounted at. The switcher's avatar handles
    // that miss itself, so this stays a plain image; the alt is empty because
    // the switcher prints the label right beside it.
    logo: <img src={addon.icon} alt="" />,
    path: addon.path!,
  }
}
