/**
 * Portainer-Run's own credential, mounted by Portainer as a Secret in this
 * add-on's namespace. It is what lets the server read its settings without
 * borrowing an administrator's token.
 */

import fs from 'node:fs'
import path from 'node:path'
import { MACHINE_CREDENTIAL_DIR } from './config.js'

const TOKEN_FILE = 'token'
const CA_FILE = 'ca.crt'

/**
 * One entry per file: what it last held, or the error that stopped it opening.
 * An absent file is neither — it is the ordinary no-credential case.
 *
 * @typedef {{
 *   content: Buffer | null,
 *   error: NodeJS.ErrnoException | null,
 *   mtimeMs?: number,
 *   size?: number,
 * }} CredentialFile
 * @type {Map<string, CredentialFile>}
 */
const files = new Map()
const reported = new Set()

/**
 * Read a file from the mounted credential, re-reading when its mtime or size
 * changes. Repairing in Portainer replaces the Secret and the kubelet swaps the
 * mount in place, so a copy held outright would lock the pod out until a
 * restart.
 *
 * @param {string} name
 * @returns {CredentialFile}
 */
function read(name) {
  const file = path.join(MACHINE_CREDENTIAL_DIR, name)

  let stat
  try {
    stat = fs.statSync(file)
  } catch (e) {
    return fail(name, file, e)
  }

  const cached = files.get(name)
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached
  }

  try {
    const entry = {
      content: fs.readFileSync(file),
      error: null,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }
    files.set(name, entry)
    return entry
  } catch (e) {
    return fail(name, file, e)
  }
}

/**
 * A file that exists but will not open degrades this add-on quietly, so say so
 * once. No mtime is recorded, so the next call retries rather than caching the
 * failure.
 */
function fail(name, file, e) {
  const absent = e?.code === 'ENOENT'

  if (!absent && !reported.has(file)) {
    reported.add(file)
    console.error(
      `⚠️  Cannot read the mounted credential at ${file}: ${e?.code || e?.message}`,
    )
  }

  const entry = { content: null, error: absent ? null : e }
  files.set(name, entry)

  return entry
}

/** Latched, so a credential that disappears is told apart from one never issued. */
let everIssued = false

export function machineToken() {
  const token = read(TOKEN_FILE).content?.toString('utf8').trim() || ''
  if (token) everIssued = true

  return token
}

/** Portainer's own TLS certificate, or null where it serves plain HTTP. */
export function portainerCA() {
  return read(CA_FILE).content
}

export function hasMachineCredential() {
  return machineToken() !== ''
}

/**
 * Whether a credential this add-on was issued has since gone. Repair
 * republishes the Secret, so unlike never having one, this has a remedy.
 */
export function credentialWithdrawn() {
  return everIssued && !hasMachineCredential()
}

/**
 * Whether the token exists but will not open. Distinct from having no token:
 * the add-on holds a credential it cannot present, which reads as healthy to
 * anything that only asks whether one is mounted.
 */
export function machineTokenUnreadable() {
  return read(TOKEN_FILE).error !== null
}

/**
 * Whether Portainer's certificate is present but unopenable, as opposed to
 * never published. Callers must not fall back to an unverified connection on
 * this.
 */
export function portainerCAUnreadable() {
  return read(CA_FILE).error !== null
}
