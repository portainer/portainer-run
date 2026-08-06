/**
 * Configuration fetched from Portainer and held in memory only, so a restart
 * starts unconfigured until something hydrates it again.
 *
 * Portainer's endpoints are admin-only and Portainer-Run has no credential, so
 * a fetch borrows an admin caller's token — from the setup screen's reload, or
 * opportunistically in handler.js. Env vars seed values for local dev.
 */

import { portainerRequest } from './lib/portainer-api.js'
import { resolvePortainerTarget } from './resolve-portainer.js'

const ADDON_ID = 'portainer-run'

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
  }
}

/**
 * Replace the in-memory copy from Portainer. Env seeds stay underneath, so a
 * setting Portainer lacks falls back rather than disappearing.
 * @param {string} token An administrator's Portainer token
 * @returns {Promise<boolean>} whether the fetch succeeded
 */
export async function hydrate(token) {
  const target = resolvePortainerTarget()
  if (!target || !token) {
    lastError = 'No Portainer target or token available'
    return false
  }

  try {
    const body = await portainerRequest(
      target,
      token,
      'GET',
      `/api/addons/${ADDON_ID}/config`,
    )
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
    return true
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    return false
  }
}

/** Hydrate unless configured, collapsing concurrent callers onto one request. */
export function ensureHydrated(token) {
  if (isConfigured()) return Promise.resolve(true)
  if (inFlight) return inFlight

  inFlight = hydrate(token).finally(() => {
    inFlight = null
  })

  return inFlight
}
