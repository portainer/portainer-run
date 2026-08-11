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
 * Read a file from the mounted credential, or null when absent. Never cached:
 * repairing in Portainer replaces the Secret and the kubelet updates the mount
 * in place, so caching would lock the pod out until a restart.
 */
function read(name) {
  try {
    return fs.readFileSync(path.join(MACHINE_CREDENTIAL_DIR, name))
  } catch {
    return null
  }
}

export function machineToken() {
  return read(TOKEN_FILE)?.toString('utf8').trim() || ''
}

/** Portainer's own TLS certificate, or null where it serves plain HTTP. */
export function portainerCA() {
  return read(CA_FILE)
}

export function hasMachineCredential() {
  return machineToken() !== ''
}
