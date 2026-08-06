/**
 * ENCRYPTION_KEY continuity check.
 *
 * A changed key fails silently: Git credentials stop decrypting and the gateway
 * identity shifts, neither of which announces itself. So we fingerprint the key
 * alongside the data it protects and compare on every start.
 *
 * The fingerprint is an HMAC keyed by the key itself, so it reveals nothing a
 * reader of the database could not already learn by trying to decrypt a row.
 */

import crypto from 'node:crypto'
import db from '../db/db.js'
import { encryptionKey, isConfigured } from '../settings.js'

const FINGERPRINT_KV_KEY = 'encryption_key_fingerprint'

/** @param {string} key */
function fingerprint(key) {
  return crypto
    .createHmac('sha256', key)
    .update('portainer-run-key-fingerprint')
    .digest('hex')
}

function readStored() {
  return (
    db.prepare('SELECT value FROM kv WHERE key = ?').get(FINGERPRINT_KV_KEY)
      ?.value ?? null
  )
}

function writeStored(value) {
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    FINGERPRINT_KV_KEY,
    value,
  )
}

/** Rows whose payload can no longer be decrypted if the key changed. */
function encryptedRowCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM connections').get()?.n ?? 0
}

function hasGatewayPsk() {
  return Boolean(
    db.prepare('SELECT value FROM kv WHERE key = ?').get('gateway_psk'),
  )
}

/**
 * @typedef {object} KeyContinuity
 * @property {'unconfigured'|'ok'|'mismatch'|'lost'} status
 *   `unconfigured` — no key, nothing encrypted: a genuine first run.
 *   `lost` — no key, but encrypted data exists. Never treat as a first run.
 * @property {number} affectedConnections  Git targets that will no longer decrypt.
 * @property {boolean} gatewayPskStale     Whether the registered gateway PSK is orphaned.
 */

/** @type {KeyContinuity | null} */
let memo = null
/** Key the memo was computed for — it can now arrive mid-process. */
let memoKey = null

/** @returns {KeyContinuity} */
function compute() {
  if (!isConfigured()) {
    // A recorded fingerprint means this volume once had a key, so it went away
    // rather than never being set — usually a release applied with an empty
    // value. Mistaking that for a first run invites generating a replacement.
    const stored = readStored()
    const affectedConnections = stored ? encryptedRowCount() : 0
    const gatewayPskStale = stored ? hasGatewayPsk() : false
    if (stored && (affectedConnections > 0 || gatewayPskStale)) {
      return { status: 'lost', affectedConnections, gatewayPskStale }
    }
    return {
      status: 'unconfigured',
      affectedConnections: 0,
      gatewayPskStale: false,
    }
  }

  const current = fingerprint(encryptionKey())
  const stored = readStored()

  if (!stored || stored === current) {
    // First boot on this volume, or the expected steady state.
    if (!stored) writeStored(current)
    return { status: 'ok', affectedConnections: 0, gatewayPskStale: false }
  }

  const affectedConnections = encryptedRowCount()
  const gatewayPskStale = hasGatewayPsk()

  // A key change with nothing encrypted behind it costs nothing — adopt it
  // silently rather than nagging about damage that cannot have happened.
  if (affectedConnections === 0 && !gatewayPskStale) {
    writeStored(current)
    return { status: 'ok', affectedConnections: 0, gatewayPskStale: false }
  }

  return { status: 'mismatch', affectedConnections, gatewayPskStale }
}

/** Verdict for the key currently held. Recomputed when that key changes. */
export function keyContinuity() {
  const key = encryptionKey()
  if (!memo || memoKey !== key) {
    memo = compute()
    memoKey = key
  }
  return memo
}

/**
 * Accept the current key as the new baseline, abandoning data encrypted under
 * the previous one. Explicit by design: this discards the old Git credentials
 * rather than recovering them.
 */
export function acknowledgeKeyChange() {
  if (!isConfigured()) return keyContinuity()
  writeStored(fingerprint(encryptionKey()))
  memo = { status: 'ok', affectedConnections: 0, gatewayPskStale: false }
  memoKey = encryptionKey()
  return memo
}

/** Log a loud, actionable warning at boot when the key changed or vanished. */
export function reportKeyContinuity() {
  const c = keyContinuity()
  if (c.status !== 'mismatch' && c.status !== 'lost') return c

  const parts = []
  if (c.affectedConnections > 0) {
    parts.push(
      `    • ${c.affectedConnections} Git target${c.affectedConnections === 1 ? '' : 's'} cannot be decrypted`,
    )
  }
  if (c.gatewayPskStale) {
    parts.push('    • the registered gateway PSK no longer matches')
  }

  console.error(
    c.status === 'lost'
      ? '\n❌  ENCRYPTION_KEY is missing, but this instance has data encrypted with one.\n' +
          parts.join('\n') +
          '\n    This is NOT a fresh install. The key was most likely dropped by a\n' +
          '    release applied with an empty value. Restore it in Portainer —\n' +
          '    generating a new one will permanently orphan the data above.\n'
      : '\n❌  ENCRYPTION_KEY has changed since this instance last started.\n' +
          parts.join('\n') +
          '\n    Restore the previous key in Portainer to recover, or acknowledge the\n' +
          '    change from Portainer-Run settings to start over with the new one.\n',
  )
  return c
}
