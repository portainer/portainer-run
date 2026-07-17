import { useEffect, useMemo } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Box, Home, MessageSquare, type LucideIcon } from 'lucide-react'

import { AppShell } from '@ds/v3-templates/AppShell/AppShell'
import type {
  BreadcrumbItem,
  SidebarSection,
} from '@ds/v3-templates/AppShell/AppShell'
import type { CommandSectionDef } from '@ds/v3-components/Command/Command'
import { Button } from '@ds/v3-components/Button/Button'

import { useAppStore } from '../store/useAppStore.js'
import { ROUTES, serviceDetailPath, serviceDetailRootPath } from '../lib/routes.js'
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

function useShellBreadcrumbs(): BreadcrumbItem[] {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const items = getBreadcrumbItems(pathname)
  return [
    {
      label: '',
      icon: <Home size={14} />,
      onClick: () => navigate(ROUTES.dashboard),
    },
    ...items.map((item: { label: string; to?: string; current?: boolean }) => ({
      label: item.label,
      onClick: item.to ? () => navigate(item.to as string) : undefined,
    })),
  ]
}

export function AppLayout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const isAdmin = useAppStore((s) => s.isAdmin)
  const isAiAvailable = useAppStore((s) => s.isAiAvailable)
  const version = useAppStore((s) => s.version)
  const chatOpen = useAppStore((s) => s.chatOpen)
  const setChatOpen = useAppStore((s) => s.setChatOpen)
  const environments = useAppStore((s) => s.environments) as EnvLike[]
  const disabledEnvs = useAppStore((s) => s.disabledEnvs) as
    | Record<string, boolean>
    | undefined
  const deployments = useAppStore((s) => s.cache.deployments) as DeploymentLike[]
  const cacheStatus = useAppStore((s) => s.cacheStatus) as string

  const sections = useMemo(() => navSections(isAdmin), [isAdmin])

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
          onSelect: () => {
            if (item.path) navigate(item.path)
            else if (item.href) window.location.assign(item.href)
          },
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
        href: item.href,
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
        onClick: () =>
          navigate(serviceDetailRootPath(f.envId, f.namespace, f.name)),
      })),
    }
    return [favoritesSection, ...navShellSections]
  }, [sections, favorites, navigate])

  const activeId =
    sections
      .flatMap((s) => s.items)
      .find((item) => item.path && pathname.startsWith(item.path))?.id ?? ''

  const breadcrumbs = useShellBreadcrumbs()

  function handleNavClick(id: string) {
    const item = sections.flatMap((s) => s.items).find((i) => i.id === id)
    if (item?.path) navigate(item.path)
  }

  return (
    <div
      className={currentApp ? undefined : 'pr-hide-fav-star'}
      style={{ display: 'flex', width: '100%', height: '100vh', overflow: 'hidden' }}
    >
      {/* Only app detail pages can be favorited. The design-system header always
          renders its star button, so hide it everywhere else via its stable
          aria-label rather than patching the read-only submodule. */}
      <style>{`.pr-hide-fav-star button[aria-label="Add to favourites"],.pr-hide-fav-star button[aria-label="Remove from favourites"]{display:none}`}</style>
      {/* App shell shrinks to make room for the assistant panel instead of being
          covered by it. */}
      <div style={{ flex: 1, minWidth: 0, height: '100vh' }}>
        <AppShell
          sections={shellSections}
          activeId={activeId}
          onItemClick={handleNavClick}
          logo={<SidebarLogo />}
          collapsedLogo={<SidebarLogoCollapsed />}
          breadcrumbs={breadcrumbs}
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
