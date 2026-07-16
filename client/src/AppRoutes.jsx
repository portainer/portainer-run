import { Routes, Route, Navigate } from 'react-router-dom'
import { useAppStore } from './store/useAppStore.js'
import { MainLayout } from './components/MainLayout.jsx'
import { ServicesPage } from './components/ServicesPage.jsx'
import { ReadinessPage } from './components/ReadinessPage.jsx'
import { GitTargetsPage } from './components/GitTargetsPage.jsx'
import {
  ServiceDetailIndexRedirect,
  ServiceDetailPage,
} from './components/ServiceDetailPage.jsx'
import { VibeDeploy } from './components/VibeDeploy.jsx'
import { ROUTES } from './lib/routes.js'

/** Shown briefly while bootstrap() validates the Portainer session cookie.
 *  If there is no valid session, bootstrap() does a full-page redirect to the
 *  Portainer login, so this never sticks around when unauthenticated. */
function SessionLoading() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
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
  return <MainLayout />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
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
        <Route path="deploy" element={<Navigate to={ROUTES.deploy} replace />} />
        <Route path="deploy/vibe" element={<VibeDeploy />} />
        <Route path="readiness" element={<ReadinessPage />} />
        <Route path="git-targets" element={<GitTargetsPage />} />
        <Route path="*" element={<Navigate to={ROUTES.services} replace />} />
      </Route>
    </Routes>
  )
}
