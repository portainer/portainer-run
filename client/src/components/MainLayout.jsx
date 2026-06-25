import { useMemo, useState, useEffect } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAppStore, visibleEnvironments } from '../store/useAppStore.js'
import { disconnect } from '../services/session.js'
import { ROUTES } from '../lib/routes.js'
import { AppBreadcrumbs } from './AppBreadcrumbs.jsx'
import { AssistantPanel } from './AssistantPanel.jsx'
import { useIsMobile } from '../hooks/useIsMobile.js'

function navClass({ isActive }) {
  return `nav-item${isActive ? ' active' : ''}`
}

function NavLinks({ onNav, isAdmin, features }) {
  const username = useAppStore((s) => s.username)
  return (
    <>
      <div className="nav-label">Workloads</div>
      <div className="nav-section">

        <NavLink to={ROUTES.services} className={navClass} onClick={onNav}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
          </svg>
          Applications
        </NavLink>
        {features.catalogue && (
          <NavLink to={ROUTES.catalogue} className={navClass} onClick={onNav}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            Catalogue
          </NavLink>
        )}
        {features.secrets && (
          <NavLink to={ROUTES.secrets} className={navClass} onClick={onNav}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Secrets
          </NavLink>
        )}
      </div>

      {(features.simpleDeploy || features.manifestBuilder || features.vibeDeploy) && (
        <>
          <div className="nav-label" style={{ marginTop: 16 }}>Deploy</div>
          <div className="nav-section">
            {features.simpleDeploy && (
              <NavLink to={ROUTES.deploy} className={navClass} onClick={onNav}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 5v14M5 12l7-7 7 7" />
                </svg>
                Simple Deploy
              </NavLink>
            )}
            {features.manifestBuilder && (
              <NavLink to={ROUTES.deployManifest} className={navClass} onClick={onNav}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                Manifest Builder
              </NavLink>
            )}
            {features.vibeDeploy && (
              <NavLink to={ROUTES.deployVibe} className={navClass} onClick={onNav}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                Vibe Deploy
              </NavLink>
            )}
          </div>
        </>
      )}

      {isAdmin && (
        <>
          <div className="nav-label" style={{ marginTop: 16 }}>Admin</div>
          <div className="nav-section">
            <NavLink to={ROUTES.gitTargets} className={navClass} onClick={onNav}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
              Git Targets
            </NavLink>
            <NavLink to={ROUTES.readiness} className={navClass} onClick={onNav}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1-8.618 3.04A12.02 12.02 0 0 0 3 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              Cluster Readiness
            </NavLink>
          </div>
        </>
      )}

      <div className="nav-label" style={{ marginTop: 16 }}>Account</div>
      <div className="nav-section">
        {username && (
          <div style={{
            padding: '6px 10px', marginBottom: 4,
            fontSize: 12, fontFamily: 'var(--mono)',
            color: 'var(--text-dim)',
            display: 'flex', alignItems: 'center', gap: 7,
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ flexShrink: 0 }}>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {username}
            </span>
            {isAdmin && (
              <span style={{ fontSize: 9, background: 'rgba(14,165,233,0.15)', color: 'var(--accent)', border: '1px solid rgba(14,165,233,0.3)', borderRadius: 3, padding: '1px 5px', flexShrink: 0 }}>
                admin
              </span>
            )}
          </div>
        )}
        <div className="nav-item" role="button" tabIndex={0}
          onClick={() => { onNav?.(); disconnect() }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNav?.(); disconnect() } }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
          Sign out
        </div>
      </div>

      {!isAdmin && (
        <>
          <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <NavLink to={ROUTES.gitTargets} className={navClass} onClick={onNav}
              style={{ opacity: 0.7 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07M8.46 8.46a5 5 0 0 0 0 7.07" />
              </svg>
              Settings
            </NavLink>
          </div>
        </>
      )}
    </>
  )
}

export function MainLayout() {
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const isAdmin = useAppStore((s) => s.isAdmin)
  const features = useAppStore((s) => s.features)
  const isAiAvailable = useAppStore((s) => s.isAiAvailable)
  const setChatOpen = useAppStore((s) => s.setChatOpen)
  const chatOpen = useAppStore((s) => s.chatOpen)
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  // Close menu and scroll to top on route change
  useEffect(() => {
    setMenuOpen(false)
    window.scrollTo(0, 0)
  }, [location.pathname])

  // Prevent body scroll when menu open
  useEffect(() => {
    if (isMobile) {
      document.body.style.overflow = menuOpen ? 'hidden' : ''
    }
    return () => { document.body.style.overflow = '' }
  }, [menuOpen, isMobile])

  const vis = useMemo(
    () => visibleEnvironments({ environments, disabledEnvs }),
    [environments, disabledEnvs],
  )

  const statusText =
    vis.length === 0 ? '0 environments'
    : vis.length === 1 ? vis[0].Name
    : `${vis.length} environments`

  return (
    <>
      {isAiAvailable ? (
        <AssistantPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      ) : null}

      <header className="app-top-header">
        <div className="app-header-brand">
          <Link to={ROUTES.dashboard} className="app-header-brand-link" title="Portainer-Run — Dashboard">
            <div className="logo">
              <img src={`${import.meta.env.BASE_URL}portainer-logo.png`} alt="Portainer" className="logo-wordmark" />
              <div className="logo-run-row">
                <div className="logo-run-square" />
                <span className="logo-run">RUN</span>
              </div>
            </div>
          </Link>
        </div>

        {!isMobile && (
          <div className="app-header-breadcrumb">
            <AppBreadcrumbs />
          </div>
        )}

        <div className="app-header-trailing">
          <div className="conn-badge" title="Connected — use Disconnect in the nav to sign out">
            <div className="dot on" />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{statusText}</span>
          </div>
          {isAiAvailable && !isMobile ? (
            <button type="button" className={`chat-toggle-btn ${chatOpen ? 'active' : ''}`}
              onClick={() => setChatOpen(!chatOpen)} title="Assistant">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span>Assistant</span>
            </button>
          ) : null}

          {isMobile && (
            <button
              type="button"
              className="mobile-hamburger"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
            >
              {menuOpen ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              )}
            </button>
          )}
        </div>
      </header>

      {/* Mobile fullscreen nav overlay */}
      {isMobile && menuOpen && (
        <div className="mobile-nav-overlay" onClick={(e) => { if (e.target === e.currentTarget) setMenuOpen(false) }}>
          <nav className="mobile-nav-drawer">
            <NavLinks onNav={() => setMenuOpen(false)} isAdmin={isAdmin} features={features} />
          </nav>
        </div>
      )}

      <div id="mainApp" className="main" style={{ display: 'grid' }}>
        {!isMobile && (
          <nav>
            <NavLinks isAdmin={isAdmin} features={features} />
          </nav>
        )}
        <div className="content">
          {isMobile && (
            <div className="mobile-breadcrumb">
              <AppBreadcrumbs />
            </div>
          )}
          <Outlet />
        </div>
      </div>
    </>
  )
}
