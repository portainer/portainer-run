/**
 * Client-side models for Git target connections. The server (via the JS
 * helpers in `lib/gitTargets.js`) returns these as loosely-typed objects, so
 * views cast the boundary results to these shapes.
 */

/**
 * The credential/config bag for a Git target. Editable fields are always
 * present (seeded by the form's `defaultPayload`); the index signature covers
 * the form's dynamic key updates.
 */
export interface GitTargetPayload {
  provider: string
  authType: string
  repo: string
  token: string
  url: string
  username: string
  pathPrefix: string
  defaultBranch: string
  tlsSkipVerify: boolean
  sshKey?: string
  sshPassphrase?: string
  [key: string]: unknown
}

/** A saved Git target connection. */
export interface GitTarget {
  id: string
  name: string
  summary?: string
  shared?: boolean
  payload?: GitTargetPayload
}
