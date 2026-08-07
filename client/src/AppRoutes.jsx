import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
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
import { SettingsPage } from './pages/settings/SettingsPage'
import { SetupPage } from './pages/setup/SetupPage'
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
  const setupRequired = useAppStore((s) => s.setupRequired)
  if (setupRequired) return <Navigate to={ROUTES.setup} replace />
  if (c) return <Navigate to={ROUTES.services} replace />
  return <SessionLoading />
}

/**
 * Until an admin completes first-run setup there is no ENCRYPTION_KEY, so Git
 * targets and deploys cannot work — the backend refuses them with a 503. Send
 * every route to the setup screen rather than letting the app render pages that
 * are guaranteed to fail.
 */
function AuthedLayout() {
  const c = useAppStore((s) => s.connected)
  const setupRequired = useAppStore((s) => s.setupRequired)
  const { pathname } = useLocation()
  if (!c) return <SessionLoading />
  if (setupRequired && pathname !== ROUTES.setup) {
    return <Navigate to={ROUTES.setup} replace />
  }
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
        <Route path="setup" element={<SetupPage />} />
        <Route path="settings" element={<SettingsPage />} />
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
