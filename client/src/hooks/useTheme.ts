import { useEffect, useRef, useState } from 'react'

import { apiFetch } from '../lib/api.js'
import {
  CURRENT_USER_STORAGE_KEY,
  getCurrentUser,
  writeCurrentUser,
} from '../lib/currentUser.js'

export type Theme = 'light' | 'dark' | 'auto' | 'highcontrast'

function readTheme(): Theme {
  return getCurrentUser()?.ThemeSettings?.color ?? 'auto'
}

function writeTheme(theme: Theme) {
  const user = getCurrentUser()
  writeCurrentUser({ ThemeSettings: { ...user?.ThemeSettings, color: theme } })
}

/** Best-effort sync to Portainer so the choice follows the user across devices. */
async function persistThemeToApi(theme: Theme) {
  const userId = getCurrentUser()?.Id
  if (!userId) return
  try {
    await apiFetch(null, `/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ theme: { color: theme } }),
    })
  } catch {
    // local storage remains the source of truth if this fails
  }
}

function resolvedTheme(theme: Theme): 'light' | 'dark' {
  // swallow highcontrast theme for now
  if (theme === 'auto' || theme === 'highcontrast') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return theme
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readTheme)
  const isFirstRun = useRef(true)

  useEffect(() => {
    const apply = () => {
      const resolved = resolvedTheme(theme)
      document.documentElement.setAttribute(
        'theme',
        resolved === 'dark' ? 'dark' : '',
      )
    }

    apply()
    writeTheme(theme)

    if (isFirstRun.current) {
      isFirstRun.current = false
    } else {
      void persistThemeToApi(theme)
    }

    // swallow highcontrast theme for now
    if (theme === 'auto' || theme === 'highcontrast') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  // Pick up theme changes made in another tab.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== CURRENT_USER_STORAGE_KEY) return
      const next = readTheme()
      setThemeState((current) => (current === next ? current : next))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return { theme, setTheme: setThemeState }
}
