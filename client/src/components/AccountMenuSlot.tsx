import * as Popover from '@radix-ui/react-popover'
import { LogOut, Monitor, Moon, Sun } from 'lucide-react'

import { Avatar } from '@ds/v3-components/Avatar/Avatar'
import { SegmentedControl } from '@ds/v3-components/Segmented/Segmented'

import { useAppStore } from '../store/useAppStore.js'
import { disconnect } from '../services/session.js'
import { useTheme, type Theme } from '../hooks/useTheme'

const APPEARANCE_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'auto', label: 'System', icon: Monitor },
]

const PANEL_SIDE_OFFSET = 8

/**
 * App-owned account menu: user card, appearance toggle, log out.
 * The design-system AccountMenu is not used because it hard-codes extra
 * items (language, settings, help, test connection) we don't want, and the
 * design-system submodule is read-only. Radix Popover provides the open/close,
 * outside-click, Escape, focus management, and positioning behaviour; styling
 * lives in styles/global.css under `.acm-*`.
 */
export function AccountMenuSlot() {
  const username = useAppStore((s) => s.username)
  const isAdmin = useAppStore((s) => s.isAdmin)
  const { theme, setTheme } = useTheme()

  const name = username || 'User'

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="ph-avatar-btn"
          aria-label={`${name} — account settings`}
        >
          <Avatar name={name} size="sm" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="acm-panel"
          align="end"
          sideOffset={PANEL_SIDE_OFFSET}
          collisionPadding={16}
          aria-label="Account menu"
        >
          <div className="acm-user">
            <Avatar name={name} size="lg" />
            <div className="acm-user-info">
              <span className="acm-user-name">{name}</span>
              {isAdmin ? <span className="acm-user-role">admin</span> : null}
            </div>
          </div>

          <div className="acm-sep" />

          <div className="acm-section">
            <span className="acm-section-label">Appearance</span>
            <SegmentedControl
              options={APPEARANCE_OPTIONS}
              value={theme}
              onChange={(v) => setTheme(v as Theme)}
              size="sm"
              corner="soft"
              stretch
              style={{ width: '100%' }}
            />
          </div>

          <div className="acm-sep" />

          <Popover.Close asChild>
            <button type="button" className="acm-logout" onClick={disconnect}>
              <LogOut size={15} aria-hidden />
              Log out
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
