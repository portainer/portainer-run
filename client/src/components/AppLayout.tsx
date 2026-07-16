import { useMemo } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Home, MessageSquare } from 'lucide-react'

import { AppShell } from '@ds/v3-templates/AppShell/AppShell'
import type {
  BreadcrumbItem,
  SidebarSection,
} from '@ds/v3-templates/AppShell/AppShell'
import { Button } from '@ds/v3-components/Button/Button'

import { useAppStore } from '../store/useAppStore.js'
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
          isAiAvailable ? (
            <Button
              variant={chatOpen ? 'filled' : 'light'}
              size="sm"
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
    </>
  )
}
