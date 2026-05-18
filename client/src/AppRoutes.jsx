import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAppStore } from './store/useAppStore.js'
import { ConnectScreen } from './components/ConnectScreen.jsx'
import { MainLayout } from './components/MainLayout.jsx'
import { DashboardPage } from './components/DashboardPage.jsx'
import { ServicesPage } from './components/ServicesPage.jsx'
import { DeployPage } from './components/DeployPage.jsx'
import { ReadinessPage } from './components/ReadinessPage.jsx'
import { CataloguePage } from './components/CataloguePage.jsx'
import { SecretsPage } from './components/SecretsPage.jsx'
import { GitTargetsPage } from './components/GitTargetsPage.jsx'
import {
  ServiceDetailIndexRedirect,
  ServiceDetailPage,
} from './components/ServiceDetailPage.jsx'
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

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="connect" element={<ConnectPage />} />
      <Route element={<AuthedLayout />}>
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route
          path="services/:envId/:namespace/:name"
          element={<ServiceDetailIndexRedirect />}
        />
        <Route
          path="services/:envId/:namespace/:name/:tab"
          element={<ServiceDetailPage />}
        />
        <Route path="deploy" element={<DeployPage />} />
        <Route path="catalogue" element={<CataloguePage />} />
        <Route path="secrets" element={<SecretsPage />} />
        <Route path="readiness" element={<ReadinessPage />} />
        <Route path="git-targets" element={<GitTargetsPage />} />
        <Route path="*" element={<Navigate to={ROUTES.dashboard} replace />} />
      </Route>
    </Routes>
  )
}
