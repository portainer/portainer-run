/**
 * Client-side API helpers for Git target connections and GitOps deploy/update.
 * All requests go to the portainer-run server (not directly to git providers).
 */

import { useAppStore } from '../store/useAppStore.js'

function serverHeaders() {
  const { portainerBaseUrl, portainerFromServer, token } = useAppStore.getState()
  const h = { 'Content-Type': 'application/json' }
  if (token) h['X-API-Key'] = token
  const u = (portainerBaseUrl || '').trim()
  if (u && !portainerFromServer) h['X-Portainer-URL'] = u
  return h
}

async function serverFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...serverHeaders(), ...(opts.headers || {}) },
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

// --- GitOps deploy / update / validate ---

/**
 * Full deploy: build manifests, commit to git, create Portainer GitOps stack.
 *
 * @param {object} p
 * @param {string} p.gitTargetId
 * @param {string} p.branch
 * @param {string} [p.pathPrefix]
 * @param {string} [p.pollInterval]  e.g. '5m', '15m', '1h' — default '5m'
 * @param {string} p.envId
 * @param {object} p.deployParams
 * @returns {Promise<{ ok: boolean, sha: string, gitPath: string, stackId?: string }>}
 */
export function gitOpsDeploy({ gitTargetId, branch, pathPrefix, pollInterval, envId, deployParams }) {
  return serverFetch('/api/gitops/deploy', {
    method: 'POST',
    body: JSON.stringify({ gitTargetId, branch, pathPrefix, pollInterval, envId, deployParams }),
  })
}

/**
 * Update: commit updated manifests to git. Portainer reconciles automatically.
 *
 * @param {object} p
 * @param {string} p.gitTargetId
 * @param {string} p.branch
 * @param {string} p.gitPath
 * @param {object} p.deployParams
 * @returns {Promise<{ ok: boolean, sha: string }>}
 */
export function gitOpsUpdate({ gitTargetId, branch, gitPath, deployParams }) {
  return serverFetch('/api/gitops/update', {
    method: 'POST',
    body: JSON.stringify({ gitTargetId, branch, gitPath, deployParams }),
  })
}

/**
 * Dry-run validate: checks manifests against the Kubernetes API without committing.
 *
 * @param {object} p
 * @param {object} p.deployParams
 * @param {string} p.envId
 * @returns {Promise<{ ok: boolean, results: { kind, name, status, message }[] }>}
 */
export function gitOpsValidate({ deployParams, manifestBuilderParams, envId }) {
  return serverFetch('/api/gitops/validate', {
    method: 'POST',
    body: JSON.stringify({ deployParams, manifestBuilderParams, envId }),
  })
}

/**
 * Delete a manifest file from the Git repo.
 * Used during service deletion when the user opts to clean up Git.
 *
 * @param {object} p
 * @param {string} p.gitTargetId
 * @param {string} p.branch
 * @param {string} p.gitPath
 * @param {string} [p.appName]
 * @returns {Promise<{ ok: boolean }>}
 */
export function gitOpsDeleteManifest({ gitTargetId, branch, gitPath, appName }) {
  return serverFetch('/api/gitops/manifest', {
    method: 'POST',
    body: JSON.stringify({ gitTargetId, branch, gitPath, appName }),
  })
}

/**
 * Deploy via Manifest Builder — commits generated manifest to git, creates Portainer GitOps stack.
 *
 * @param {object} p
 * @param {string} p.gitTargetId
 * @param {string} p.branch
 * @param {string} [p.pathPrefix]
 * @param {string} [p.pollInterval]
 * @param {string} p.envId
 * @param {object} p.manifestBuilderParams  — full ManifestBuilder form state
 */
export function gitOpsDeployManifestBuilder({ gitTargetId, branch, pathPrefix, pollInterval, envId, manifestBuilderParams }) {
  return serverFetch('/api/gitops/deploy', {
    method: 'POST',
    body: JSON.stringify({ gitTargetId, branch, pathPrefix, pollInterval, envId, manifestBuilderParams }),
  })
}

/**
 * Fetch raw manifest YAML from Git for editing.
 * @param {object} p
 * @param {string} p.gitTargetId
 * @param {string} p.branch
 * @param {string} p.gitPath
 * @returns {Promise<{ content: string }>}
 */
export function gitOpsFetchManifest({ gitTargetId, branch, gitPath }) {
  const params = new URLSearchParams({ gitTargetId, branch, path: gitPath })
  return serverFetch(`/api/gitops/manifest?${params}`)
}
