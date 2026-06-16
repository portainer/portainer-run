import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAppStore } from './store/useAppStore.js'
import { ConnectScreen } from './components/ConnectScreen.jsx'
import { MainLayout } from './components/MainLayout.jsx'
import { ServicesPage } from './components/ServicesPage.jsx'
import { ReadinessPage } from './components/ReadinessPage.jsx'
import { GitTargetsPage } from './components/GitTargetsPage.jsx'
import {
  ServiceDetailIndexRedirect,
  ServiceDetailPage,
} from './components/ServiceDetailPage.jsx'
import { VibeDeploy } from './components/VibeDeploy.jsx'
import { ROUTES, getSafeAppPath } from './lib/routes.js'

function RootRedirect() {
  const c = useAppStore((s) => s.connected)
  if (c) return <Navigate to={ROUTES.services} replace />
  return <Navigate to={ROUTES.connect} replace />
}

function ConnectPage() {
  const c = useAppStore((s) => s.connected)
  const loc = useLocation()
  if (c) {
    const to = getSafeAppPath(loc.state?.from) || ROUTES.services
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

/** Redirects to services if vibeDeploy feature flag is disabled. */
function FeatureGate({ flag, children }) {
  const features = useAppStore((s) => s.features)
  if (features[flag] === false) return <Navigate to={ROUTES.services} replace />
  return children
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="connect" element={<ConnectPage />} />
      <Route element={<AuthedLayout />}>
        <Route path="dashboard" element={<Navigate to={ROUTES.services} replace />} />
        <Route path="applications" element={<ServicesPage />} />
        <Route
          path="applications/:envId/:namespace/:name"
          element={<ServiceDetailIndexRedirect />}
        />
        <Route
          path="applications/:envId/:namespace/:name/:tab"
          element={<ServiceDetailPage />}
        />
        <Route path="deploy" element={<Navigate to={ROUTES.deployVibe} replace />} />
        <Route path="deploy/vibe" element={<FeatureGate flag="vibeDeploy"><VibeDeploy /></FeatureGate>} />
        <Route path="readiness" element={<ReadinessPage />} />
        <Route path="git-targets" element={<GitTargetsPage />} />
        <Route path="*" element={<Navigate to={ROUTES.services} replace />} />
      </Route>
    </Routes>
  )
}
