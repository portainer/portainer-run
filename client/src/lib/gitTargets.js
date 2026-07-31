/**
 * Client-side API helpers for Git target connections and GitOps deploy/update.
 * All requests go to the portainer-run server (not directly to git providers).
 */

import { serverFetch as rawFetch } from './api.js'

async function serverFetch(path, opts = {}) {
  const res = await rawFetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

// --- Git target CRUD ---

/** @returns {Promise<{ connections: object[] }>} */
export function listGitTargets() {
  return serverFetch('/api/connections')
}

/** @param {string} id @returns {Promise<{ connection: object }>} */
export function getGitTarget(id) {
  return serverFetch(`/api/connections/${id}`)
}

/**
 * @param {{ name: string, payload: object }} data
 * @returns {Promise<{ connection: object }>}
 */
export function createGitTarget(data) {
  return serverFetch('/api/connections', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/** @param {string} id @param {{ name: string, payload: object }} data */
export function updateGitTarget(id, data) {
  return serverFetch(`/api/connections/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

/** @param {string} id */
export function deleteGitTarget(id) {
  return serverFetch(`/api/connections/${id}`, { method: 'DELETE' })
}

/** Test a saved connection. @param {string} id */
export function initializeGitTarget(id) {
  return serverFetch(`/api/connections/${id}/initialize`, { method: 'POST' })
}

export function testGitTarget(id) {
  return serverFetch(`/api/connections/${id}/test`, { method: 'POST' })
}

/** Test an unsaved payload (before save). @param {object} payload */
export function testGitTargetPayload(payload) {
  return serverFetch('/api/connections/test', {
    method: 'POST',
    body: JSON.stringify({ payload }),
  })
}

/**
 * List branches for a saved git target.
 * @param {string} id
 * @returns {Promise<{ branches: string[] }>}
 */
export function listBranches(id) {
  return serverFetch(`/api/connections/${id}/branches`)
}

/**
 * List a single directory level for a branch (entry base names + type).
 * Feeds the lazy-loading "Source from Git" folder picker in Vibe Deploy so the
 * whole repository is never preloaded — each folder is fetched only when opened.
 * @param {string} id
 * @param {string} branch
 * @param {string} [path]  repo-relative folder path ('' for the repository root)
 * @returns {Promise<{ files: Array<{ path: string, type: 'file'|'dir' }> }>}
 */
export function listRepoDir(id, branch, path = '') {
  const params = new URLSearchParams({ branch })
  if (path) params.set('path', path)
  return serverFetch(`/api/connections/${id}/files?${params.toString()}`)
}

// --- App manifest cleanup ---

/**
 * Remove multiple paths (manifest file + source directory) in a single commit.
 * Avoids the non-fast-forward race of two sequential delete commits.
 */
export function deleteAppPaths({ gitTargetId, branch, paths, appName }) {
  return serverFetch('/api/vibe/delete-manifest', {
    method: 'POST',
    body: JSON.stringify({ gitTargetId, branch, paths, appName }),
  })
}

/**
 * Delete the Portainer stack that owns an app. Portainer's own teardown removes
 * every resource declared in the stack's manifest, so this replaces deleting
 * those resources one by one through the Kubernetes API.
 *
 * @param {{ envId: string|number, stackId: string|number }} args
 */
export async function deleteAppStack({ envId, stackId }) {
  const data = await serverFetch('/api/vibe/delete-stack', {
    method: 'POST',
    body: JSON.stringify({ envId: String(envId), stackId: String(stackId) }),
  })
  // A 200 is not sufficient proof the stack was deleted. Unknown backend routes
  // fall through to the SPA's index.html, which is also served with a 200 — so a
  // missing or misrouted endpoint parses as {} and would otherwise read as
  // success, silently skipping teardown while the caller reports the app gone.
  if (data?.ok !== true) {
    throw new Error(
      'Unexpected response from delete-stack — the endpoint may be missing or misrouted',
    )
  }
}
