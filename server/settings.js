/**
 * Portainer-Run's configuration, fetched from Portainer and held in memory.
 *
 * Settings live in Portainer's addon store. Nothing delivers them into the
 * cluster — no Helm values, no Secret — so this process fetches them and keeps
 * them in memory only. A restart therefore starts unconfigured until something
 * hydrates it again.
 *
 * Portainer's settings endpoints are administrator-only and Portainer-Run holds
 * no credential of its own, so a fetch has to borrow an admin caller's token.
 * Two things do that: the setup screen calls reload right after saving, and any
 * admin request rehydrates opportunistically (see handler.js). A machine
 * credential will replace both and remove the cold-start gap.
 *
 * Environment variables still seed the initial values, which keeps local
 * development and any operator-configured deployment working unchanged.
 */

import { portainerRequest } from './lib/portainer-api.js'
import { resolvePortainerTarget } from './resolve-portainer.js'

const ADDON_ID = 'portainer-run'

export const MIN_ENCRYPTION_KEY_LENGTH = 32

/** Settings Portainer may hold. Anything else it stores is ignored. */
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

/** Whether a usable encryption key is present, and so whether setup is done. */
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

/** Explicit override, else whichever provider has a key. */
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
 * Fetch settings from Portainer using an administrator's token and replace the
 * in-memory copy.
 *
 * Values seeded from the environment are kept underneath, so a setting Portainer
 * does not hold falls back to it rather than disappearing.
 *
 * @param {string} token  An administrator's Portainer token
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

/**
 * Hydrate unless already configured, collapsing concurrent callers onto one
 * request so a burst of admin traffic does not fan out to Portainer.
 *
 * @param {string} token
 */
export function ensureHydrated(token) {
  if (isConfigured()) return Promise.resolve(true)
  if (inFlight) return inFlight

  inFlight = hydrate(token).finally(() => {
    inFlight = null
  })

  return inFlight
}
