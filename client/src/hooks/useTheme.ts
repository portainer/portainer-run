import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system' | 'highcontrast'

const STORAGE_KEY = 'portainer.current_user'

interface StoredUser {
  state?: {
    user?: {
      ThemeSettings?: {
        color?: Theme
      }
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

function readStoredUser(): StoredUser {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredUser) : {}
  } catch {
    return {}
  }
}

function readTheme(): Theme {
  return readStoredUser().state?.user?.ThemeSettings?.color ?? 'system'
}

function writeTheme(theme: Theme) {
  const stored = readStoredUser()
  const next: StoredUser = {
    ...stored,
    state: {
      ...stored.state,
      user: {
        ...stored.state?.user,
        ThemeSettings: {
          ...stored.state?.user?.ThemeSettings,
          color: theme,
        },
      },
    },
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

function resolvedTheme(theme: Theme): 'light' | 'dark' {
  // swallow highcontrast theme for now
  if (theme === 'system' || theme === 'highcontrast') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return theme
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readTheme)

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

    // swallow highcontrast theme for now
    if (theme === 'system' || theme === 'highcontrast') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  return { theme, setTheme: setThemeState }
}
