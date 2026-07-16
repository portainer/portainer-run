import { useEffect } from 'react'
import { inflightDedupe } from './lib/inflightDedupe.js'
import { useAppStore } from './store/useAppStore.js'
import { bootstrap } from './services/session.js'
import { AppRoutes } from './AppRoutes.jsx'
import { DeleteModal } from './components/DeleteModal'
import { RestartModal } from './components/RestartModal'
import { Toasts } from './components/Toasts'

export function App() {
  const connected = useAppStore((s) => s.connected)

  useEffect(() => {
    void inflightDedupe('app:init-bootstrap', () => bootstrap())
  }, [])

  return (
    <div>
      <AppRoutes />
      {connected ? <DeleteModal /> : null}
      {connected ? <RestartModal /> : null}
      <Toasts />
    </div>
  )
}
