import { useMemo } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Home, MessageSquare } from 'lucide-react'

import { AppShell } from '@ds/v3-templates/AppShell/AppShell'
import type {
  BreadcrumbItem,
  SidebarSection,
} from '@ds/v3-templates/AppShell/AppShell'
import { Button } from '@ds/v3-components/Button/Button'
import { StatusDot } from '@ds/v3-components/StatusDot/StatusDot'

import { useAppStore, visibleEnvironments } from '../store/useAppStore.js'
import { disconnect } from '../services/session.js'
import { ROUTES } from '../lib/routes.js'
import { getBreadcrumbItems } from '../lib/breadcrumbs.js'
import { navSections } from '../nav/sections'
import { SidebarLogo, SidebarLogoCollapsed } from './Logo'
import { AccountMenuSlot } from './AccountMenuSlot'
import { AssistantPanel } from './AssistantPanel'

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

  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const isAdmin = useAppStore((s) => s.isAdmin)
  const isAiAvailable = useAppStore((s) => s.isAiAvailable)
  const version = useAppStore((s) => s.version)
  const chatOpen = useAppStore((s) => s.chatOpen)
  const setChatOpen = useAppStore((s) => s.setChatOpen)

  const sections = useMemo(() => navSections(isAdmin), [isAdmin])

  const shellSections: SidebarSection[] = useMemo(
    () =>
      sections.map((s) => ({
        id: s.id,
        label: s.label,
        items: s.items.map((item) => ({
          id: item.id,
          label: item.label,
          icon: item.icon,
          href: item.href,
        })),
      })),
    [sections],
  )

  const activeId =
    sections
      .flatMap((s) => s.items)
      .find((item) => item.path && pathname.startsWith(item.path))?.id ?? ''

  const breadcrumbs = useShellBreadcrumbs()

  const vis = useMemo(
    () => visibleEnvironments({ environments, disabledEnvs }),
    [environments, disabledEnvs],
  )

  const statusText =
    vis.length === 0
      ? '0 environments'
      : vis.length === 1
        ? vis[0].Name
        : `${vis.length} environments`

  function handleNavClick(id: string) {
    if (id === 'sign-out') {
      disconnect()
      return
    }
    const item = sections.flatMap((s) => s.items).find((i) => i.id === id)
    if (item?.path) navigate(item.path)
  }

  return (
    <>
      {isAiAvailable ? (
        <AssistantPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      ) : null}

      <AppShell
        sections={shellSections}
        activeId={activeId}
        onItemClick={handleNavClick}
        logo={<SidebarLogo />}
        collapsedLogo={<SidebarLogoCollapsed />}
        breadcrumbs={breadcrumbs}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
                  title="Connected — use Disconnect in the nav to sign out"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--muted)',
                whiteSpace: 'nowrap',
              }}
            >
              <StatusDot tone="success" />
              {statusText}
            </span>
            {isAiAvailable ? (
              <Button
                variant={chatOpen ? 'filled' : 'light'}
                size="sm"
                leftSection={<MessageSquare size={13} />}
                onClick={() => setChatOpen(!chatOpen)}
                title="Assistant"
              >
                Assistant
              </Button>
            ) : null}
          </div>
        }
        avatarSlot={<AccountMenuSlot />}
        sidebarFooter={
          <span title="Portainer-Run release">Portainer-Run {version}</span>
        }
      >
        <Outlet />
      </AppShell>
    </>
  )
}
