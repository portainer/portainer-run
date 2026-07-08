import { Link, useLocation } from 'react-router-dom'
import { getBreadcrumbItems } from '../lib/breadcrumbs.js'
import { icons } from '../design-system/icons.js'
import { ROUTES } from '../lib/routes.js'

function isHomePath(path) {
  return path === '/dashboard' || path === '/'
}

export function AppBreadcrumbs() {
  const { pathname } = useLocation()
  const path = (pathname || '/').replace(/\/$/, '') || '/'
  const items = getBreadcrumbItems(pathname)
  const atHome = isHomePath(path)

  return (
    <nav className="app-breadcrumbs" aria-label="Breadcrumb">
      <ol className="app-breadcrumbs-list">
        <li className="app-breadcrumbs-item app-breadcrumbs-item--home">
          {atHome ? (
            <span
              className="app-breadcrumbs-home app-breadcrumbs-home--current"
              aria-current="page"
              title="Home"
            >
              <span
                className="app-breadcrumbs-home-icon"
                aria-hidden
                dangerouslySetInnerHTML={{ __html: icons.home }}
              />
            </span>
          ) : (
            <Link
              to={ROUTES.dashboard}
              className="app-breadcrumbs-home"
              title="Home"
              aria-label="Home"
            >
              <span
                className="app-breadcrumbs-home-icon"
                aria-hidden
                dangerouslySetInnerHTML={{ __html: icons.home }}
              />
            </Link>
          )}
        </li>
        {items.map((item, i) => (
          <li key={`${item.label}-${i}`} className="app-breadcrumbs-item">
            <span
              className="app-breadcrumbs-sep"
              aria-hidden
              dangerouslySetInnerHTML={{ __html: icons.chevronRightMedium }}
            />
            {item.current ? (
              <span className="app-breadcrumbs-current" aria-current="page">
                {item.label}
              </span>
            ) : item.to ? (
              <Link to={item.to} className="app-breadcrumbs-link">
                {item.label}
              </Link>
            ) : (
              <span className="app-breadcrumbs-text">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
