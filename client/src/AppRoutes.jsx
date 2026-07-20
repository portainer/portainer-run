import { Routes, Route, Navigate } from 'react-router-dom'
import { useAppStore } from './store/useAppStore.js'
import { AppLayout } from './components/AppLayout'
import { ServicesPage } from './pages/ServicesPage'
import { ReadinessPage } from './pages/readiness/ReadinessPage'
import { GitTargetsPage } from './pages/git-targets/GitTargetsPage'
import {
  ServiceDetailIndexRedirect,
  ServiceDetailPage,
} from './pages/service-detail/ServiceDetailPage'
import { VibeDeploy } from './pages/deploy/DeployPage'
import { ROUTES } from './lib/routes.js'

/** Shown briefly while bootstrap() validates the Portainer session cookie.
 *  If there is no valid session, bootstrap() does a full-page redirect to the
 *  Portainer login, so this never sticks around when unauthenticated. */
function SessionLoading() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
      }}
    >
      Loading…
    </div>
  )
}

function RootRedirect() {
  const c = useAppStore((s) => s.connected)
  if (c) return <Navigate to={ROUTES.services} replace />
  return <SessionLoading />
}

function AuthedLayout() {
  const c = useAppStore((s) => s.connected)
  if (!c) return <SessionLoading />
  return <AppLayout />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route element={<AuthedLayout />}>
        <Route
          path="dashboard"
          element={<Navigate to={ROUTES.services} replace />}
        />
        <Route path="applications" element={<ServicesPage />} />
        <Route
          path="applications/:envId/:namespace/:name"
          element={<ServiceDetailIndexRedirect />}
        />
        <Route
          path="applications/:envId/:namespace/:name/:tab"
          element={<ServiceDetailPage />}
        />
        <Route
          path="deploy"
          element={<Navigate to={ROUTES.deploy} replace />}
        />
        <Route path="deploy/vibe" element={<VibeDeploy />} />
        <Route path="readiness" element={<ReadinessPage />} />
        <Route path="git-targets" element={<GitTargetsPage />} />
        <Route path="*" element={<Navigate to={ROUTES.services} replace />} />
      </Route>
    </Routes>
  )
}
