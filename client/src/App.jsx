import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore.js'
import { loadServerConfig } from './services/config.js'
import { tryAutoConnect } from './services/session.js'
import { AppRoutes } from './AppRoutes.jsx'
import { DeleteModal } from './components/DeleteModal.jsx'
import { Toasts } from './components/Toasts.jsx'

export function App() {
  const connected = useAppStore((s) => s.connected)

  useEffect(() => {
    void (async () => {
      await loadServerConfig()
      await tryAutoConnect()
    })()
  }, [])

  return (
    <div className="app">
      <AppRoutes />
      {connected ? <DeleteModal /> : null}
      <Toasts />
    </div>
  )
}
