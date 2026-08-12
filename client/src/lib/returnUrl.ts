/**
 * Record where to come back to before sending the user to Portainer's login.
 * Portainer reads this after authenticating and returns the user here rather
 * than to its own home page.
 *
 * This is Portainer's own storage, not ours: the add-on is served same-origin
 * behind the gateway, so it is the same localStorage — see currentUser.js for
 * the same arrangement. The value must be JSON-encoded under the `portainer.`
 * prefix, because that is how Portainer reads it back; a raw string is dropped
 * on the parse error with no visible failure.
 */
export function storeReturnUrl(): void {
  const { pathname, search, hash } = window.location
  try {
    localStorage.setItem(
      'portainer.RETURN_URL',
      JSON.stringify(`${pathname}${search}${hash}`),
    )
  } catch {
    // Storage full or disabled — login falls back to its usual landing page.
  }
}
