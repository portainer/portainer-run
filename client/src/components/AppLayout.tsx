import { forwardRef, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Box, Home, MessageSquare, type LucideIcon } from 'lucide-react'

import { AppShell } from '@ds/v3-templates/AppShell/AppShell'
import type {
  BreadcrumbItem,
  SidebarSection,
} from '@ds/v3-templates/AppShell/AppShell'
import type { CommandSectionDef } from '@ds/v3-components/Command/Command'
import { Button } from '@ds/v3-components/Button/Button'

import { useAppStore } from '../store/useAppStore.js'
import {
  ROUTES,
  serviceDetailPath,
  serviceDetailRootPath,
} from '../lib/routes.js'
import { getBreadcrumbItems } from '../lib/breadcrumbs.js'
import { navSections } from '../nav/sections'
import {
  favoriteKey,
  pruneFavorites,
  toggleFavorite,
  useFavorites,
  type Favorite,
} from '../lib/favorites'
import { SidebarLogo, SidebarLogoCollapsed } from './Logo'
import { AccountMenuSlot } from './AccountMenuSlot'
import { AssistantPanel } from './AssistantPanel'
import { ApplicationSwitcher } from '@ds/v3-templates/ApplicationSwitcher/ApplicationSwitcher.tsx'
import { getAddons } from '@/lib/getAddons.ts'
import type { SwitcherProduct } from '@/lib/addonToProduct.tsx'

/** This app's own entry in the switcher — always present, always the selected one. */
const SELF_PRODUCT: SwitcherProduct = {
  id: 'portainer-run',
  label: 'Portainer-Run',
  logo: <img src="/assets/addons/portainer-run.svg" alt="Portainer-Run logo" />,
  description: "Drag'n'drop deployment for Apps",
  available: true,
  path: import.meta.env.BASE_URL,
}

/** Portainer itself — the way back out. Served same-origin, so `/` is Portainer. */
const PORTAINER_OPS_PRODUCT: SwitcherProduct = {
  id: 'portainer-ops',
  label: 'Portainer Ops',
  logo: <img src="/assets/addons/portainer-ops.svg" alt="Portainer Ops logo" />,
  description: 'Infrastructure and cluster management',
  available: true,
  path: '/',
}

interface EnvLike {
  Id: string | number
  Name?: string
}

interface DeploymentLike {
  _envId: string | number
  metadata?: { name?: string; namespace?: string }
}

// Rendered in a favorite's sidebar icon slot as a small "APP" tag. The
// design-system SidebarNavItem only accepts a Lucide icon, so we pass a
// component (cast to LucideIcon) that renders the tag instead of an icon.
const AppFavTag = (() => (
  <span
    style={{
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.04em',
      color: 'var(--accent, #2e90fa)',
      background: 'color-mix(in srgb, var(--accent, #2e90fa) 14%, transparent)',
      borderRadius: 4,
      padding: '2px 4px',
      lineHeight: 1,
    }}
  >
    APP
  </span>
)) as unknown as LucideIcon

/** Parse the app-detail route (root or a tab) into a Favorite, else null. */
function appFromPath(pathname: string): Favorite | null {
  const segs = pathname.split('/').filter(Boolean)
  if (segs[0] !== 'applications' || segs.length < 4) return null
  return {
    envId: decodeURIComponent(segs[1]),
    namespace: decodeURIComponent(segs[2]),
    name: decodeURIComponent(segs[3]),
  }
}

/**
 * Link element the design-system shell (sidebar nav items + breadcrumbs)
 * renders through its `as` prop. Passing a real router `Link` — rather than an
 * `onClick` handler — is what gives these controls native cmd/ctrl/middle-click
 * "open in new tab" behavior.
 */
const ShellLink = forwardRef<
  HTMLAnchorElement,
  { to?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>
>(function ShellLink({ to, ...rest }, ref) {
  return <Link ref={ref} to={to ?? '#'} {...rest} />
})

function useShellBreadcrumbs(appSwitcher?: ReactNode): BreadcrumbItem[] {
  const { pathname } = useLocation()
  const items = getBreadcrumbItems(pathname)
  const isAppRoute = appFromPath(pathname) !== null
  return [
    {
      label: '',
      icon: <Home size={14} />,
      linkProps: { to: ROUTES.dashboard },
    },
    ...items.map(
      (item: { label: string; to?: string; current?: boolean }, i: number) => ({
        label: item.label,
        linkProps: item.to ? { to: item.to } : undefined,
        // On an app route getBreadcrumbItems always emits
        // [Applications, <app name>, …], so index 1 is the app crumb — the
        // one the switcher replaces. Matching on the label instead would
        // misfire on an app named after a tab.
        switcher:
          isAppRoute && i === 1 && appSwitcher ? appSwitcher : undefined,
      }),
    ),
  ]
}

export function AppLayout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [addons, setAddons] = useState<SwitcherProduct[]>([])
  const [addonsLoading, setAddonsLoading] = useState<boolean>(true)

  const isAdmin = useAppStore((s) => s.isAdmin)
  const portainerAccessDenied = useAppStore((s) => s.portainerAccessDenied)
  const isAiAvailable = useAppStore((s) => s.isAiAvailable)
  const version = useAppStore((s) => s.version)
  const chatOpen = useAppStore((s) => s.chatOpen)
  const setChatOpen = useAppStore((s) => s.setChatOpen)
  const environments = useAppStore((s) => s.environments) as EnvLike[]
  const disabledEnvs = useAppStore((s) => s.disabledEnvs) as
    Record<string, boolean> | undefined
  const deployments = useAppStore(
    (s) => s.cache.deployments,
  ) as DeploymentLike[]
  const cacheStatus = useAppStore((s) => s.cacheStatus) as string

  const sections = useMemo(() => navSections(isAdmin), [isAdmin])

  // this will all be removed when react-query handles loading states
  useEffect(() => {
    setAddonsLoading(true)
    getAddons()
      .then((list) => setAddons(list ?? []))
      .catch(() => setAddons([]))
      .finally(() => setAddonsLoading(false))
  }, [])

  // Portainer Ops leads the list, mirroring Portainer's own switcher.
  const products: SwitcherProduct[] = [
    ...(portainerAccessDenied ? [] : [PORTAINER_OPS_PRODUCT]),
    SELF_PRODUCT,
    ...addons,
  ]

  // Command palette (⌘K): search deployed apps by name, plus quick navigation.
  const commandSections = useMemo<CommandSectionDef[]>(() => {
    const visibleEnvIds = new Set(
      environments
        .filter((e) => !disabledEnvs?.[String(e.Id)])
        .map((e) => String(e.Id)),
    )

    const appItems = deployments
      .filter((d) => visibleEnvIds.has(String(d._envId)))
      .map((d) => {
        const appName = d.metadata?.name ?? ''
        const ns = d.metadata?.namespace ?? ''
        return {
          id: `app:${d._envId}:${ns}:${appName}`,
          label: appName,
          icon: <Box size={14} />,
          shortcut: ns,
          onSelect: () => navigate(serviceDetailPath(d._envId, ns, appName)),
        }
      })
      .filter((item) => item.label)

    const navItems = sections
      .flatMap((s) => s.items)
      .map((item) => {
        const Icon = item.icon
        return {
          id: `nav:${item.id}`,
          label: item.label,
          icon: <Icon size={14} />,
          onSelect: () => navigate(item.path),
        }
      })

    const result: CommandSectionDef[] = []
    if (appItems.length) result.push({ title: 'Applications', items: appItems })
    result.push({ title: 'Navigation', items: navItems })
    return result
  }, [environments, disabledEnvs, deployments, sections, navigate])

  const favorites = useFavorites()

  // Once deployments are confirmed fresh from the server, drop any favorites
  // that point at apps which no longer exist. Gated on 'fresh' so we never prune
  // against a still-loading (empty) or possibly-stale cached list.
  useEffect(() => {
    if (cacheStatus !== 'fresh') return
    const valid = new Set(
      deployments.map((d) =>
        favoriteKey({
          envId: String(d._envId),
          namespace: d.metadata?.namespace ?? '',
          name: d.metadata?.name ?? '',
        }),
      ),
    )
    pruneFavorites(valid)
  }, [cacheStatus, deployments])

  const currentApp = useMemo(() => appFromPath(pathname), [pathname])
  const starred = currentApp
    ? favorites.some((f) => favoriteKey(f) === favoriteKey(currentApp))
    : false

  const shellSections: SidebarSection[] = useMemo(() => {
    const navShellSections = sections.map((s) => ({
      id: s.id,
      label: s.label,
      items: s.items.map((item) => ({
        id: item.id,
        label: item.label,
        icon: item.icon,
        linkProps: { to: item.path },
      })),
    }))

    if (!favorites.length) return navShellSections

    // Favorites pinned at the top, opening each app at its detail-page root.
    const favoritesSection: SidebarSection = {
      id: 'favorites',
      label: 'Favorites',
      items: favorites.map((f) => ({
        id: `fav:${favoriteKey(f)}`,
        label: f.name,
        icon: AppFavTag,
        linkProps: {
          to: serviceDetailRootPath(f.envId, f.namespace, f.name),
        },
      })),
    }
    return [favoritesSection, ...navShellSections]
  }, [sections, favorites])

  const activeId =
    sections
      .flatMap((s) => s.items)
      .find((item) => pathname.startsWith(item.path))?.id ?? ''

  /* Every app the user can reach, as switcher items. Labels are the bare app
     name: nearly every user can deploy into a single environment, so the
     environment adds noise to every row to disambiguate a case they will not
     hit. Ids stay the full env/ns/name key, so apps that do share a name
     across environments remain distinct targets. */
  const appSwitcherItems = useMemo(() => {
    const visibleEnvIds = new Set(
      environments
        .filter((e) => !disabledEnvs?.[String(e.Id)])
        .map((e) => String(e.Id)),
    )
    return deployments
      .filter((d) => visibleEnvIds.has(String(d._envId)))
      .map((d) => ({
        envId: String(d._envId),
        namespace: d.metadata?.namespace ?? '',
        name: d.metadata?.name ?? '',
      }))
      .filter((r) => r.name)
      .map((r) => ({ id: favoriteKey(r), label: r.name, target: r }))
      .sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
      )
  }, [environments, disabledEnvs, deployments])

  /* Keep the tab when switching apps — going from one app's Logs to another's
     Logs is the point of switching here. */
  const currentTab = useMemo(() => {
    const segs = pathname.split('/').filter(Boolean)
    return segs[0] === 'applications' && segs.length >= 5
      ? decodeURIComponent(segs[4])
      : 'overview'
  }, [pathname])

  /* Only once the current app is actually in the list: ApplicationSwitcher
     falls back to items[0] when `selected` matches nothing, which would show
     the wrong app (or crash on an empty list) while the cache is still
     loading. Until then the crumb stays plain text. */
  const currentAppId = currentApp ? favoriteKey(currentApp) : null
  const appSwitcher =
    currentAppId &&
    appSwitcherItems.length > 1 &&
    appSwitcherItems.some((i) => i.id === currentAppId) ? (
      <ApplicationSwitcher
        inlineMode
        selected={currentAppId}
        items={appSwitcherItems.map(({ id, label }) => ({ id, label }))}
        searchable={appSwitcherItems.length > 7}
        dropdownLabel="Applications"
        onChange={(id: string) => {
          const hit = appSwitcherItems.find((i) => i.id === id)
          if (!hit || id === currentAppId) return
          navigate(
            serviceDetailPath(
              hit.target.envId,
              hit.target.namespace,
              hit.target.name,
              currentTab,
            ),
          )
        }}
      />
    ) : undefined

  const breadcrumbs = useShellBreadcrumbs(appSwitcher)

  // Other products are separately served apps, not routes in this SPA.
  function handleProductChange(id: string) {
    if (id === SELF_PRODUCT.id) return
    const product = products.find((p) => p.id === id)
    if (product) window.location.href = product.path
  }

  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      {/* App shell shrinks to make room for the assistant panel instead of being
          covered by it. */}
      <div style={{ flex: 1, minWidth: 0, height: '100vh' }}>
        <AppShell
          sections={shellSections}
          activeId={activeId}
          as={ShellLink}
          logo={<SidebarLogo />}
          collapsedLogo={<SidebarLogoCollapsed />}
          productSlot={(collapsed) => (
            <ApplicationSwitcher
              products={products}
              selected={SELF_PRODUCT.id}
              onChange={handleProductChange}
              sidebarMode
              collapsed={collapsed}
              onLogoClick={() => navigate('/')}
              loading={addonsLoading}
            />
          )}
          breadcrumbs={breadcrumbs}
          showStar={!!currentApp}
          starred={starred}
          onStarToggle={
            currentApp ? () => toggleFavorite(currentApp) : undefined
          }
          commandSections={commandSections}
          actions={
            isAiAvailable ? (
              <Button
                variant={chatOpen ? 'filled' : 'light'}
                leftSection={<MessageSquare size={13} />}
                onClick={() => setChatOpen(!chatOpen)}
                title="Assistant"
              >
                Assistant
              </Button>
            ) : undefined
          }
          avatarSlot={<AccountMenuSlot />}
          sidebarFooter={
            <span title="Portainer-Run release">Portainer-Run {version}</span>
          }
        >
          <Outlet />
        </AppShell>
      </div>

      {/* Assistant panel: an in-flow column on the right. Kept mounted (width 0
          when closed) so chat history survives open/close. */}
      {isAiAvailable ? (
        <div
          style={{
            flexShrink: 0,
            height: '100vh',
            width: chatOpen ? 400 : 0,
            overflow: 'hidden',
            transition: 'width 180ms ease-out',
          }}
        >
          <AssistantPanel open={chatOpen} onClose={() => setChatOpen(false)} />
        </div>
      ) : null}
    </div>
  )
}
