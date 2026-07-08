/**
 * Client-side API helpers for Git target connections and GitOps deploy/update.
 * All requests go to the portainer-run server (not directly to git providers).
 */

import { serverFetch as rawFetch } from './api.js'

async function serverFetch(path, opts = {}) {
  const res = await rawFetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
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

// --- App manifest cleanup ---

/**
 * Delete a manifest file or source directory from the Git repo.
 * Used during application deletion to clean up Git.
 *
 * @param {object} p
 * @param {string} p.gitTargetId
 * @param {string} p.branch
 * @param {string} p.gitPath
 * @param {string} [p.appName]
 * @returns {Promise<{ ok: boolean }>}
 */
export function deleteAppManifest({ gitTargetId, branch, gitPath, appName }) {
  return serverFetch('/api/vibe/delete-manifest', {
    method: 'POST',
    body: JSON.stringify({ gitTargetId, branch, gitPath, appName }),
  })
}
