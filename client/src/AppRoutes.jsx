import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAppStore } from './store/useAppStore.js'
import { ConnectScreen } from './components/ConnectScreen.jsx'
import { MainLayout } from './components/MainLayout.jsx'
import { DashboardPage } from './components/DashboardPage.jsx'
import { ServicesPage } from './components/ServicesPage.jsx'
import { PlaceholderPage } from './components/PlaceholderPage.jsx'
import { ROUTES, getSafeAppPath } from './lib/routes.js'

function RootRedirect() {
  const c = useAppStore((s) => s.connected)
  if (c) return <Navigate to={ROUTES.dashboard} replace />
  return <Navigate to={ROUTES.connect} replace />
}

function ConnectPage() {
  const c = useAppStore((s) => s.connected)
  const loc = useLocation()
  if (c) {
    const to = getSafeAppPath(loc.state?.from) || ROUTES.dashboard
    return <Navigate to={to} replace />
  }
  return <ConnectScreen />
}

function AuthedLayout() {
  const c = useAppStore((s) => s.connected)
  const loc = useLocation()
  if (!c) {
    return (
      <Navigate
        to={ROUTES.connect}
        replace
        state={{ from: loc.pathname + loc.search }}
      />
    )
  }
  return <MainLayout />
}

function ReadinessPage() {
  const isAdmin = useAppStore((s) => s.isAdmin)
  if (!isAdmin) return <Navigate to={ROUTES.dashboard} replace />
  return (
    <PlaceholderPage title="Cluster readiness">
      <p>Readiness checks will run from here; UI wiring TBD.</p>
    </PlaceholderPage>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="connect" element={<ConnectPage />} />
      <Route element={<AuthedLayout />}>
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route
          path="deploy"
          element={
            <PlaceholderPage title="Deploy a service">
              <p>Deploy form will be available here. Use the classic UI or add the full form to this app.</p>
            </PlaceholderPage>
          }
        />
        <Route
          path="catalogue"
          element={
            <PlaceholderPage title="Catalogue">
              <p>Template catalogue loads from the server; UI wiring TBD.</p>
            </PlaceholderPage>
          }
        />
        <Route
          path="secrets"
          element={
            <PlaceholderPage title="Secrets">
              <p>Namespace secrets will be listed here; UI wiring TBD.</p>
            </PlaceholderPage>
          }
        />
        <Route path="readiness" element={<ReadinessPage />} />
        <Route path="*" element={<Navigate to={ROUTES.dashboard} replace />} />
      </Route>
    </Routes>
  )
}
