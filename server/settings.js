/**
 * Configuration fetched from Portainer and held in memory only, so a restart
 * refetches rather than starting from disk.
 *
 * A fetch authenticates as the add-on where Portainer has issued it a
 * credential, which is what lets it run at startup with no user behind it, and
 * otherwise borrows an admin caller's token so the two sides can be released
 * independently. Env vars seed values for local dev.
 */

import { portainerRequest } from './lib/portainer-api.js'
import { resolvePortainerTarget } from './resolve-portainer.js'
import { hasMachineCredential, machineToken } from './machine-credential.js'

const ADDON_ID = 'portainer-run'

const MACHINE_CONFIG_PATH = '/api/addon-store/v1/config'
const ADMIN_CONFIG_PATH = `/api/addons/${ADDON_ID}/config`

export const MIN_ENCRYPTION_KEY_LENGTH = 32

/** Anything Portainer stores outside this list is ignored. */
const KNOWN_KEYS = [
  'ENCRYPTION_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AI_PROVIDER',
  'OPENAI_MODEL',
  'BASE_DOMAIN',
  'GATEWAY_URL',
]

function envSeed() {
  const seed = {}
  for (const key of KNOWN_KEYS) {
    const value = process.env[key]
    if (value) seed[key] = value
  }
  return seed
}

const seeded = envSeed()

/** @type {Record<string, string>} */
let values = { ...seeded }
let hydratedAt = null
let lastError = null
/** @type {Promise<boolean> | null} */
let inFlight = null
/** Set when this add-on's own credential was refused or could not be trusted. */
let credentialRejected = false

/** @param {string} key */
export function getSetting(key) {
  return values[key] ?? ''
}

export function encryptionKey() {
  return getSetting('ENCRYPTION_KEY')
}

/** Whether setup is done. */
export function isConfigured() {
  return encryptionKey().length >= MIN_ENCRYPTION_KEY_LENGTH
}

export function gatewayUrl() {
  return getSetting('GATEWAY_URL').replace(/\/$/, '')
}

export function baseDomain() {
  return getSetting('BASE_DOMAIN')
}

export function anthropicKey() {
  return getSetting('ANTHROPIC_API_KEY')
}

export function openaiKey() {
  return getSetting('OPENAI_API_KEY')
}

export function openaiModel() {
  return getSetting('OPENAI_MODEL') || 'gpt-4o'
}

/** Explicit override, else whichever has a key. */
export function aiProvider() {
  return (
    getSetting('AI_PROVIDER') ||
    (anthropicKey() ? 'anthropic' : openaiKey() ? 'openai' : '')
  )
}

export function settingsStatus() {
  return {
    hydrated: hydratedAt !== null,
    hydratedAt,
    configured: isConfigured(),
    lastError,
    hasCredential: hasMachineCredential(),
    credential: credentialHealth(),
  }
}

/**
 * How this add-on's own credential is faring, as /healthz reports it.
 *
 * 'credential-invalid' is what Portainer offers a Repair for, so a credential
 * that has merely never worked yet reports separately — that is usually a
 * Portainer which was not up, and Repair would send an administrator after a
 * fault that is not there.
 *
 * @returns {'ok' | 'credential-invalid' | 'settings-unavailable'}
 */
export function credentialHealth() {
  // A credential since removed has nothing left to repair.
  if (!hasMachineCredential()) return 'ok'

  if (credentialRejected) return 'credential-invalid'
  // Env-seeded settings skip hydration, so never hydrating is not a fault.
  if (hydratedAt === null && !isConfigured()) return 'settings-unavailable'

  return 'ok'
}

/** Shortest gap between retries, so a fast prober cannot hammer Portainer. */
const CREDENTIAL_RETRY_INTERVAL = 15_000
let lastCredentialRetry = 0

/**
 * Re-read the credential and try again after it failed.
 *
 * Hydration is otherwise retried only by inbound API traffic, so an idle add-on
 * stays broken after a repair. Portainer's health probe calls this, making the
 * thing that reports the fault the thing that clears it. Not awaited, so the
 * probe stays fast.
 */
export function retryFailedHydration() {
  if (credentialHealth() === 'ok') return
  if (Date.now() - lastCredentialRetry < CREDENTIAL_RETRY_INTERVAL) return

  // Stamped before the await so concurrent probes cannot stack up retries.
  lastCredentialRetry = Date.now()
  hydrate().catch(() => {})
}

/**
 * Whether reaching Portainer failed on its certificate — Node reports these on
 * `code` with no status attached. The chain failures are the ones that do not
 * carry CERT in the name.
 */
function isCertificateError(e) {
  const code = e?.code
  if (typeof code !== 'string') return false

  return (
    code.includes('CERT') ||
    code.startsWith('ERR_TLS') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN'
  )
}

/**
 * Replace the in-memory copy from Portainer. Env seeds stay underneath, so a
 * setting Portainer lacks falls back rather than disappearing.
 *
 * @param {string} [adminToken] Only used where no credential is mounted
 * @returns {Promise<boolean>} whether the fetch succeeded
 */
export async function hydrate(adminToken) {
  const target = resolvePortainerTarget()
  if (!target) {
    lastError = 'No Portainer target available'
    return false
  }

  const machine = machineToken()
  const token = machine || adminToken
  if (!token) {
    lastError =
      'No add-on credential is mounted and no admin token was supplied'
    return false
  }

  const path = machine ? MACHINE_CONFIG_PATH : ADMIN_CONFIG_PATH

  try {
    const body = await portainerRequest(target, token, 'GET', path)
    const entries = Array.isArray(body?.entries) ? body.entries : []

    const fetched = {}
    for (const entry of entries) {
      if (!entry?.key || typeof entry.value !== 'string') continue
      if (!KNOWN_KEYS.includes(entry.key)) continue
      fetched[entry.key] = entry.value
    }

    values = { ...seeded, ...fetched }
    hydratedAt = Date.now()
    lastError = null
    credentialRejected = false
    return true
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    // A borrowed admin token says nothing about this add-on's credential. A
    // refusal and an untrusted certificate share one remedy: republish both.
    credentialRejected =
      Boolean(machine) &&
      (e?.status === 401 || e?.status === 403 || isCertificateError(e))
    return false
  }
}

/**
 * Hydrate unless configured, collapsing concurrent callers onto one request.
 * @param {string} [adminToken] Only needed where no credential is mounted.
 */
export function ensureHydrated(adminToken) {
  if (isConfigured()) return Promise.resolve(true)
  if (inFlight) return inFlight

  inFlight = hydrate(adminToken).finally(() => {
    inFlight = null
  })

  return inFlight
}
