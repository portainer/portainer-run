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
import {
  credentialWithdrawn,
  hasMachineCredential,
  machineToken,
  machineTokenUnreadable,
  portainerCAUnreadable,
} from './machine-credential.js'
import { credentialFailure } from './lib/credential-fault.js'

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
/** Whether Portainer holds this add-on's ENCRYPTION_KEY. */
let keyCameFromPortainer = false
/**
 * @typedef {'adopted'|'settled'|'retry'} AdoptionOutcome
 *   `settled` — Portainer holds a key, or there is no local one to hand over.
 *   `retry` — the attempt could not be made yet, which says nothing either way.
 */

/** Latched once the key's home is decided. */
let adoptionSettled = false

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

// Unset disables MCP deploys: the relay carries app source, so egress is the operator's call.
export function gatewayUrl() {
  const raw = getSetting('GATEWAY_URL').trim()
  if (!raw) return ''
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return url.replace(/\/+$/, '')
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
    gateway: gatewayUrl(),
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
  // A file that exists and will not open is a credential the add-on holds and
  // cannot present, so ask that before asking whether it works.
  if (credentialUnreadable()) return 'credential-invalid'

  if (credentialWithdrawn()) return 'credential-invalid'

  // Never issued one: nothing to repair.
  if (!hasMachineCredential()) return 'ok'

  if (credentialFailure()) return 'credential-invalid'
  // Env-seeded settings skip hydration, so never hydrating is not a fault.
  if (hydratedAt === null && !isConfigured()) return 'settings-unavailable'

  return 'ok'
}

function credentialUnreadable() {
  return machineTokenUnreadable() || portainerCAUnreadable()
}

/**
 * Shortest gap between opportunistic hydrations, so neither a fast prober nor
 * unauthenticated traffic turns into a Portainer round trip per request.
 */
const HYDRATE_RETRY_INTERVAL = 15_000
let lastHydrateAttempt = 0

/**
 * How long a hydrated add-on trusts its last proof that the credential works.
 * Nothing expires the settings themselves; an add-on nobody is using makes no
 * other call to find a credential broken since.
 */
const CREDENTIAL_PROOF_TTL = 5 * 60_000

function overdueForProof() {
  // Env seeds were never proved by a call, so there is nothing to re-prove.
  if (hydratedAt === null) return false

  return Date.now() - hydratedAt >= CREDENTIAL_PROOF_TTL
}

/** @returns {'rejected' | 'certificate' | 'unreadable' | 'withdrawn' | undefined} */
export function credentialFault() {
  if (credentialUnreadable()) return 'unreadable'
  if (credentialWithdrawn()) return 'withdrawn'

  return credentialFailure() ?? undefined
}

/**
 * Replace the in-memory copy from Portainer. Env seeds stay underneath, so a
 * setting Portainer lacks falls back rather than disappearing.
 *
 * @param {string} [adminToken] Only used where no credential is mounted
 * @returns {Promise<boolean>} whether the fetch succeeded
 */
async function hydrate(adminToken) {
  const target = resolvePortainerTarget()
  if (!target) {
    lastError = 'No Portainer target available'
    return false
  }

  const machine = machineToken()
  // Prefer the add-on's own credential, but let a caller's token through once
  // that credential has been refused, so a broken one can be recovered without
  // uninstalling.
  const asAdmin =
    Boolean(adminToken) && (!machine || credentialFailure() !== null)
  const token = asAdmin ? adminToken : machine
  if (!token) {
    lastError =
      'No add-on credential is mounted and no admin token was supplied'
    return false
  }

  const path = asAdmin ? ADMIN_CONFIG_PATH : MACHINE_CONFIG_PATH

  try {
    const body = await portainerRequest(target, token, 'GET', path)
    // A 200 carrying something else is not an add-on with no settings yet:
    // treating it as one would invite an administrator to generate a second
    // ENCRYPTION_KEY over data the first one encrypted.
    if (!Array.isArray(body?.entries)) {
      throw new Error('Portainer returned no configuration entry list')
    }

    const fetched = {}
    for (const entry of body.entries) {
      if (!entry?.key || typeof entry.value !== 'string') continue
      if (!KNOWN_KEYS.includes(entry.key)) continue
      fetched[entry.key] = entry.value
    }

    values = { ...seeded, ...fetched }
    hydratedAt = Date.now()
    lastError = null
    keyCameFromPortainer = 'ENCRYPTION_KEY' in fetched
    return true
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    return false
  }
}

/**
 * Collapse concurrent callers onto one request.
 * @param {string} [adminToken] Only needed where no credential is mounted.
 */
function hydrateOnce(adminToken) {
  if (inFlight) return inFlight

  lastHydrateAttempt = Date.now()
  inFlight = hydrate(adminToken).finally(() => {
    inFlight = null
  })

  return inFlight
}

/**
 * Fetch again, for an administrator who has just saved.
 *
 * A hydrate already running was started before that save, so joining it would
 * report a pre-save snapshot as a successful reload. Waiting for it to settle
 * also keeps the two from assigning the settings out of order.
 *
 * @param {string} [adminToken] Only needed where no credential is mounted.
 */
export function refetch(adminToken) {
  const settled = inFlight ? inFlight.catch(() => {}) : Promise.resolve()

  return settled.then(() => hydrateOnce(adminToken))
}

/**
 * Fetch unless there is nothing left to fetch for.
 *
 * The one opportunistic entry point: startup, unidentified inbound traffic and
 * Portainer's health probe all arrive here, so none can pick a variant that
 * skips the throttle or the in-flight collapse. An administrator's explicit
 * reload goes through refetch instead.
 *
 * Throttled because the caller may be traffic that has not been identified yet:
 * an unconfigured instance must not turn every request into a round trip.
 *
 * @param {string} [adminToken] Only needed where no credential is mounted, or
 * where the mounted one has been refused.
 * @returns {Promise<boolean>}
 */
export function ensureHydrated(adminToken) {
  // Settings can be live from an env seed or an earlier fetch while the
  // credential is not, so being configured is not on its own a reason to stop.
  if (isConfigured() && credentialHealth() === 'ok' && !overdueForProof())
    return Promise.resolve(true)
  if (!machineToken() && !adminToken) return Promise.resolve(false)
  if (inFlight) return inFlight
  if (Date.now() - lastHydrateAttempt < HYDRATE_RETRY_INTERVAL) {
    return Promise.resolve(false)
  }

  return hydrateOnce(adminToken)
}

/**
 * Whether the key this process holds came from its own environment rather than
 * Portainer. That is the one that can be adopted: storing it in Portainer is
 * what makes it outlive this pod.
 */
export function encryptionKeyIsLocal() {
  return isConfigured() && !keyCameFromPortainer
}

/**
 * Hand an environment-seeded ENCRYPTION_KEY to Portainer, so it outlives this pod.
 *
 * Unattended: by the time an administrator could press Adopt in setup, the
 * Secret that a later release drops is already gone.
 *
 * @returns {Promise<AdoptionOutcome>}
 */
export async function adoptEnvKey() {
  if (adoptionSettled || !encryptionKeyIsLocal()) return 'settled'

  const target = resolvePortainerTarget()
  const token = machineToken()
  if (!target || !token) return 'retry'

  // Ask first: a stale chart seed must not overwrite a key Portainer holds, and
  // a configured instance never fetches on its own.
  if (!(await hydrateOnce())) return 'retry'
  if (keyCameFromPortainer) {
    adoptionSettled = true
    return 'settled'
  }

  // A key stored between the read-back and here is overwritten on purpose: the
  // rows on this volume are encrypted with the one being handed over.
  try {
    await portainerRequest(
      target,
      token,
      'PATCH',
      `${MACHINE_CONFIG_PATH}/ENCRYPTION_KEY`,
      JSON.stringify({ value: encryptionKey(), sensitive: true }),
    )
  } catch (e) {
    // Never record the key, or a message that might carry it.
    lastError = e instanceof Error ? e.message : String(e)
    return 'retry'
  }

  keyCameFromPortainer = true
  adoptionSettled = true

  return 'adopted'
}
