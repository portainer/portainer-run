// Auth model: Portainer Run is served as an addon behind the Portainer gateway
// at `import.meta.env.BASE_URL` (e.g. /addons/portainer-run/), same-origin with
// Portainer. The browser carries Portainer's HttpOnly `portainer_api_key`
// session cookie automatically, so:
//   - Calls to Portainer's own API go to the root-relative `/api` (NOT prefixed
//     with the addon base) and rely on the cookie — no token, no headers.
//   - Calls to Portainer Run's own backend must carry the addon base prefix so
//     the gateway routes them to us (it strips the prefix before forwarding).

/** Prefix a Portainer Run backend path with the addon base (no trailing slash). */
export function serverUrl(path) {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
  return base + (path.startsWith('/') ? path : '/' + path)
}

/** Fetch a Portainer Run backend endpoint (cookie-authenticated, base-prefixed). */
export function serverFetch(path, opts = {}) {
  return fetch(serverUrl(path), { credentials: 'include', ...opts })
}

/**
 * Call the Portainer API directly. The `token` argument is retained for
 * call-site compatibility but ignored — auth rides on the session cookie.
 * @param {unknown} _token @param {string} path @param {RequestInit} [opts]
 */
export function apiFetch(_token, path, opts = {}) {
  return fetch('/api' + path, {
    credentials: 'include',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
}

export function kubeFetch(token, envId, path, opts = {}) {
  return apiFetch(token, `/endpoints/${envId}/kubernetes${path}`, opts)
}
