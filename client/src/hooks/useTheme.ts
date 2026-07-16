import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

function resolvedTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return theme
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem('theme') as Theme) ?? 'system'
  })

  useEffect(() => {
    const apply = () => {
      const resolved = resolvedTheme(theme)
      document.documentElement.setAttribute(
        'theme',
        resolved === 'dark' ? 'dark' : '',
      )
    }

    apply()
    localStorage.setItem('theme', theme)

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  return { theme, setTheme: setThemeState }
}
