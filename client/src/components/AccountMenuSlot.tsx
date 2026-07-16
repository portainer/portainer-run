import { AccountMenu } from '@ds/v3-templates/AccountMenu/AccountMenu'
import { useAppStore } from '../store/useAppStore.js'
import { disconnect } from '../services/session.js'
import { useTheme, type Theme } from '../hooks/useTheme'

export function AccountMenuSlot() {
  const username = useAppStore((s) => s.username)
  const isAdmin = useAppStore((s) => s.isAdmin)
  const { theme, setTheme } = useTheme()

  return (
    <AccountMenu
      user={{ name: username || 'User', email: isAdmin ? 'admin' : '' }}
      appearance={theme}
      onAppearanceChange={(mode) => setTheme(mode as Theme)}
      onLogout={() => disconnect()}
    />
  )
}
