import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LogOut, Monitor, Moon, Sun } from 'lucide-react'

import { Avatar } from '@ds/v3-components/Avatar/Avatar'
import { SegmentedControl } from '@ds/v3-components/Segmented/Segmented'

import { useAppStore } from '../store/useAppStore.js'
import { disconnect } from '../services/session.js'
import { useTheme, type Theme } from '../hooks/useTheme'

const APPEARANCE_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/**
 * App-owned account menu: user card, appearance toggle, log out.
 * The design-system AccountMenu is not used because it hard-codes extra
 * items (language, settings, help, test connection) we don't want, and the
 * design-system submodule is read-only. Styles live in styles/global.css
 * under `.acm-*`.
 */
export function AccountMenuSlot() {
  const username = useAppStore((s) => s.username)
  const isAdmin = useAppStore((s) => s.isAdmin)
  const { theme, setTheme } = useTheme()

  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState({ top: 0, right: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const name = username || 'User'

  function openMenu() {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const isMobile = window.matchMedia('(max-width: 639px)').matches
    setPanelStyle({
      top: rect.bottom + 8,
      right: isMobile ? 16 : window.innerWidth - rect.right,
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) {
        setOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ph-avatar-btn"
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${name} — account settings`}
      >
        <Avatar name={name} size="sm" />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Account menu"
            className="acm-panel"
            style={{ top: panelStyle.top, right: panelStyle.right }}
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

            <button
              type="button"
              className="acm-logout"
              onClick={() => {
                setOpen(false)
                disconnect()
              }}
            >
              <LogOut size={15} aria-hidden />
              Log out
            </button>
          </div>,
          document.body,
        )}
    </>
  )
}
