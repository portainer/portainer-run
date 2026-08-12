// Portainer core reads this to decide where to send the user after login. The
// add-on is served same-origin behind the gateway, so this is the same
// localStorage core writes — see currentUser.js for the same arrangement.
const STORAGE_KEY = 'portainer.last_viewed_addon'

type LastViewedByUser = Record<string, string>

function isLastViewedByUser(value: unknown): value is LastViewedByUser {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function read(): LastViewedByUser {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return isLastViewedByUser(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Keyed by user so a shared browser never lands one user in another's add-on. */
export function setLastViewedAddon(userId: string, addonId: string): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...read(), [userId]: addonId }),
    )
  } catch {
    // Storage full or disabled — landing falls back to Portainer's default.
  }
}
