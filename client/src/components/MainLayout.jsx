import { useMemo } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAppStore, visibleEnvironments } from '../store/useAppStore.js'
import { disconnect } from '../services/session.js'
import { ROUTES } from '../lib/routes.js'

function navClass({ isActive }) {
  return `nav-item${isActive ? ' active' : ''}`
}

export function MainLayout() {
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const isAdmin = useAppStore((s) => s.isAdmin)
  const isAiAvailable = useAppStore((s) => s.isAiAvailable)
  const setChatOpen = useAppStore((s) => s.setChatOpen)
  const chatOpen = useAppStore((s) => s.chatOpen)

  const vis = useMemo(
    () => visibleEnvironments({ environments, disabledEnvs }),
    [environments, disabledEnvs],
  )

  const statusText =
    vis.length === 0
      ? '0 environments'
      : vis.length === 1
        ? vis[0].Name
        : `${vis.length} environments`

  return (
    <>
      <header>
        <div className="logo">
          <div className="logo-icon">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          Portainer Run
        </div>
        <div className="header-sep" />
        <div className="conn-badge" title="Connected — use Disconnect in the nav to sign out">
          <div className="dot on" />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{statusText}</span>
        </div>
        {isAiAvailable ? (
          <button
            type="button"
            className={`chat-toggle-btn ${chatOpen ? 'active' : ''}`}
            onClick={() => setChatOpen(!chatOpen)}
            title="Assistant"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Assistant</span>
          </button>
        ) : null}
      </header>

      <div id="mainApp" className="main" style={{ display: 'grid' }}>
        <nav>
          <div className="nav-label">Workloads</div>
          <div className="nav-section">
            <NavLink
              to={ROUTES.dashboard}
              className={navClass}
              end
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              Dashboard
            </NavLink>
            <NavLink to={ROUTES.services} className={navClass}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
              Services
            </NavLink>
            <NavLink to={ROUTES.deploy} className={navClass}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 5v14M5 12l7-7 7 7" />
              </svg>
              Deploy
            </NavLink>
            <NavLink to={ROUTES.catalogue} className={navClass}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              Catalogue
            </NavLink>
            <NavLink to={ROUTES.secrets} className={navClass}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Secrets
            </NavLink>
          </div>
          {isAdmin ? (
            <>
              <div className="nav-label" style={{ marginTop: 16 }}>
                Admin
              </div>
              <div className="nav-section">
                <NavLink to={ROUTES.readiness} className={navClass}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1-8.618 3.04A12.02 12.02 0 0 0 3 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  Cluster Readiness
                </NavLink>
              </div>
            </>
          ) : null}
          <div className="nav-label" style={{ marginTop: 16 }}>
            Session
          </div>
          <div className="nav-section">
            <div
              className="nav-item"
              role="button"
              tabIndex={0}
              onClick={() => disconnect()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  disconnect()
                }
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
              Disconnect
            </div>
          </div>
        </nav>

        <div className="content">
          <Outlet />
        </div>
      </div>
    </>
  )
}
