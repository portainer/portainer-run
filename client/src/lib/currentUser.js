// Mirrors the shape Portainer's own frontend stores in localStorage, so
// portainer-run can read/write the same record:
//   { state: { user: { Id, Username, ThemeSettings: { color }, ... } } }
export const CURRENT_USER_STORAGE_KEY = 'portainer.current_user'

// The record is shared with Portainer and any other same-origin code, so it can
// hold any JSON at all; only an object is a record, the rest reads as empty.
export function readCurrentUser() {
  try {
    const raw = localStorage.getItem(CURRENT_USER_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : undefined
    const isRecord =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    return isRecord ? parsed : {}
  } catch {
    return {}
  }
}

export function getCurrentUser() {
  return readCurrentUser().state?.user
}

/** Shallow-merge `patch` into the stored user and persist it. */
export function writeCurrentUser(patch) {
  const stored = readCurrentUser()
  const next = {
    ...stored,
    state: {
      ...stored.state,
      user: { ...stored.state?.user, ...patch },
    },
  }
  localStorage.setItem(CURRENT_USER_STORAGE_KEY, JSON.stringify(next))
  return next
}
