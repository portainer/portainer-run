/**
 * Gateway client for the Portainer-Run file relay (run-gateway).
 *
 * Each Portainer-Run instance derives a stable instanceId from its
 * ENCRYPTION_KEY and auto-registers with the gateway to obtain a PSK on
 * first use. The PSK is stored in the local SQLite kv table and reused on
 * subsequent calls. If the gateway rejects the PSK (e.g. after a gateway
 * wipe) it re-registers once automatically.
 *
 * Public API:
 *   requestUploadSession() → { sessionId, uploadUrl, expiresAt }
 *   fetchStagedFiles(sessionId) → Array<{ path, content, encoding? }>
 */

import crypto from 'node:crypto'
import { encryptionKey, gatewayUrl } from '../settings.js'
import db from '../db/db.js'

const NO_GATEWAY =
  'No file relay is configured, so MCP deploys are disabled. Set GATEWAY_URL in ' +
  'Portainer-Run Settings. Portainer hosts one at https://run-gateway.portainer.ai, ' +
  'but app source transits the relay — egress-restricted installs should host their own.'

// ---------------------------------------------------------------------------
// Instance identity — derived from ENCRYPTION_KEY, stable across restarts
// ---------------------------------------------------------------------------

function getInstanceId() {
  // An empty HMAC key is legal in Node, so without this an unconfigured
  // instance would register a meaningless identity and lose it once keyed.
  const key = encryptionKey()
  if (!key) {
    throw new Error(
      'Cannot derive a gateway identity: Portainer-Run is awaiting setup',
    )
  }
  return crypto
    .createHmac('sha256', key)
    .update('portainer-run-gateway-id')
    .digest('hex')
}

// ---------------------------------------------------------------------------
// PSK storage
// ---------------------------------------------------------------------------

function getStoredPsk() {
  return (
    db.prepare('SELECT value FROM kv WHERE key = ?').get('gateway_psk')
      ?.value ?? null
  )
}

function storePsk(psk) {
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    'gateway_psk',
    psk,
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function register() {
  const instanceId = getInstanceId()
  const res = await fetch(`${gatewayUrl()}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(
      `Gateway registration failed (${res.status}): ${body.error || 'unknown error'}`,
    )
  }
  const { psk } = await res.json()
  storePsk(psk)
  console.log(`[gateway] registered instance ${instanceId.slice(0, 16)}…`)
  return psk
}

async function ensurePsk() {
  return getStoredPsk() ?? register()
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Request a new upload session from the gateway.
 * Returns { sessionId, uploadUrl, expiresAt }.
 * The AI coding assistant uploads files directly to uploadUrl.
 */
export async function requestUploadSession() {
  if (!gatewayUrl()) throw new Error(NO_GATEWAY)

  let psk = await ensurePsk()

  async function attempt(currentPsk) {
    return fetch(`${gatewayUrl()}/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentPsk}` },
    })
  }

  let res = await attempt(psk)

  // PSK rejected — gateway may have been wiped. Re-register once and retry.
  if (res.status === 401) {
    console.log('[gateway] PSK rejected — re-registering')
    psk = await register()
    res = await attempt(psk)
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(
      `Gateway session request failed (${res.status}): ${body.error || 'unknown error'}`,
    )
  }

  return res.json() // { sessionId, uploadUrl, expiresAt }
}

/**
 * Fetch staged files from the gateway by sessionId.
 * Single-use — the gateway deletes the session on first retrieval.
 * Returns Array<{ path, content, encoding? }> matching the sourceFiles shape
 * that vibe.js expects.
 */
export async function fetchStagedFiles(sessionId) {
  if (!gatewayUrl()) throw new Error(NO_GATEWAY)

  const res = await fetch(
    `${gatewayUrl()}/download/${encodeURIComponent(sessionId)}`,
  )

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(
      `Gateway download failed (${res.status}): ${body.error || 'unknown error'}`,
    )
  }

  const files = await res.json()
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      'Gateway returned an empty or invalid file list for this session',
    )
  }

  return files
}
