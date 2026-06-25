import { Routes, Route, Navigate } from 'react-router-dom'
import { useAppStore } from './store/useAppStore.js'
import { MainLayout } from './components/MainLayout.jsx'
import { DashboardPage } from './components/DashboardPage.jsx'
import { ServicesPage } from './components/ServicesPage.jsx'
import { DeployPage } from './components/DeployPage.jsx'
import { ManifestBuilderPage } from './components/deployManifest/ManifestBuilderPage.jsx'
import { ReadinessPage } from './components/ReadinessPage.jsx'
import { CataloguePage } from './components/CataloguePage.jsx'
import { SecretsPage } from './components/SecretsPage.jsx'
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

/** Redirects to dashboard if a feature flag is disabled. */
function FeatureGate({ flag, children }) {
  const features = useAppStore((s) => s.features)
  if (features[flag] === false) return <Navigate to={ROUTES.services} replace />
  return children
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
        <Route path="deploy/simple" element={<FeatureGate flag="simpleDeploy"><DeployPage /></FeatureGate>} />
        <Route path="deploy/manifest" element={<FeatureGate flag="manifestBuilder"><ManifestBuilderPage /></FeatureGate>} />
        <Route path="deploy/vibe" element={<FeatureGate flag="vibeDeploy"><VibeDeploy /></FeatureGate>} />
        <Route path="catalogue" element={<FeatureGate flag="catalogue"><CataloguePage /></FeatureGate>} />
        <Route path="secrets" element={<FeatureGate flag="secrets"><SecretsPage /></FeatureGate>} />
        <Route path="readiness" element={<ReadinessPage />} />
        <Route path="git-targets" element={<GitTargetsPage />} />
        <Route path="*" element={<Navigate to={ROUTES.services} replace />} />
      </Route>
    </Routes>
  )
}
