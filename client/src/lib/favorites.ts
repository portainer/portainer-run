import { useSyncExternalStore } from 'react'

/**
 * Favorited application. Only app detail pages can be favorited, so a favorite
 * is fully identified by its environment, namespace, and name — enough to open
 * the app's detail page root.
 */
export interface Favorite {
  envId: string
  namespace: string
  name: string
}

const STORAGE_KEY = 'portainer-run.favorites'

/** Stable identity for a favorite (also used for de-duplication). */
export function favoriteKey(f: Favorite): string {
  return `${f.envId}/${f.namespace}/${f.name}`
}

function readStorage(): Favorite[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((f) => f && f.envId != null && f.namespace && f.name)
      .map((f) => ({
        envId: String(f.envId),
        namespace: String(f.namespace),
        name: String(f.name),
      }))
  } catch {
    return []
  }
}

// Module-level cache so useSyncExternalStore can hand out a stable snapshot
// reference that only changes when the list actually changes.
let cache: Favorite[] = readStorage()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function write(next: Favorite[]) {
  cache = next
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* storage full / disabled — keep the in-memory list */
    }
  }
  emit()
}

export function getFavorites(): Favorite[] {
  return cache
}

export function isFavorite(f: Favorite): boolean {
  const key = favoriteKey(f)
  return cache.some((x) => favoriteKey(x) === key)
}

export function addFavorite(f: Favorite) {
  if (isFavorite(f)) return
  write([
    ...cache,
    { envId: String(f.envId), namespace: f.namespace, name: f.name },
  ])
}

export function removeFavorite(f: Favorite) {
  const key = favoriteKey(f)
  const next = cache.filter((x) => favoriteKey(x) !== key)
  if (next.length !== cache.length) write(next)
}

export function toggleFavorite(f: Favorite) {
  if (isFavorite(f)) removeFavorite(f)
  else addFavorite(f)
}

/**
 * Drop favorites whose key isn't in `validKeys` — used to clear out favorites
 * pointing at apps that no longer exist. No-op when nothing changes.
 */
export function pruneFavorites(validKeys: Set<string>) {
  const next = cache.filter((f) => validKeys.has(favoriteKey(f)))
  if (next.length !== cache.length) write(next)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  // Sync when another tab edits the same storage key.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cache = readStorage()
      emit()
    }
  }
  if (typeof window !== 'undefined')
    window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    if (typeof window !== 'undefined')
      window.removeEventListener('storage', onStorage)
  }
}

/** Reactive list of favorites, kept in sync with localStorage and other tabs. */
export function useFavorites(): Favorite[] {
  return useSyncExternalStore(subscribe, getFavorites, getFavorites)
}
