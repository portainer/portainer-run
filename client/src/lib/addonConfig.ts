/**
 * Portainer-Run's configuration in Portainer's addon store. Portainer keeps
 * opaque key/value entries; their meaning lives here. Calls go straight to
 * Portainer on the admin's own session cookie.
 */

import { apiFetch, serverFetch } from './api.js'

/** This addon's id in Portainer's registry — matches server/routes/setup.js. */
export const ADDON_ID = 'portainer-run'

const CONFIG_PATH = `/addons/${ADDON_ID}/config`

export const ENCRYPTION_KEY_ENTRY = 'ENCRYPTION_KEY'

/** Bytes of entropy behind a generated ENCRYPTION_KEY (→ 64 hex chars). */
const ENCRYPTION_KEY_BYTES = 32

export interface SettingDef {
  key: string
  label: string
  /** Sensitive values are encrypted at rest by Portainer and masked on read. */
  sensitive: boolean
  required: boolean
  /** Generated client-side rather than typed in. */
  generated?: boolean
  /** Locked once Portainer holds a value: rotating it destroys encrypted data. */
  immutableOnceSet?: boolean
  help: string
  placeholder?: string
  /** Rejects a value; returns null when acceptable. */
  validate?: (value: string) => string | null
}

export const SETTINGS: SettingDef[] = [
  {
    key: ENCRYPTION_KEY_ENTRY,
    label: 'Encryption key',
    sensitive: true,
    required: true,
    generated: true,
    immutableOnceSet: true,
    help: 'Encrypts stored Git target credentials and derives this instance’s gateway identity. Generated for you and kept by Portainer — it must stay the same for the life of the installation.',
    validate: (v) => (v.length < 32 ? 'Must be at least 32 characters.' : null),
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    sensitive: true,
    required: false,
    help: 'Enables AI triage using Claude. Set this or an OpenAI key.',
    placeholder: 'sk-ant-…',
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'OpenAI API key',
    sensitive: true,
    required: false,
    help: 'Enables AI triage using OpenAI instead of Anthropic.',
    placeholder: 'sk-…',
  },
  {
    key: 'BASE_DOMAIN',
    label: 'Base domain',
    sensitive: false,
    required: false,
    help: 'Wildcard domain used to build ingress hostnames for deployed apps. Without it, apps fall back to NodePort URLs.',
    placeholder: 'apps.example.com',
    validate: (v) =>
      /^[a-z0-9.-]+$/i.test(v)
        ? null
        : 'Use a bare hostname — no scheme, port, or path.',
  },
  {
    key: 'GATEWAY_URL',
    label: 'Gateway URL',
    sensitive: false,
    required: false,
    help: 'File relay used when uploading app sources from an AI assistant.',
    placeholder: 'https://run-gateway.portainer.ai',
    validate: (v) => {
      try {
        new URL(v)
        return null
      } catch {
        return 'Must be a full URL, e.g. https://run-gateway.portainer.ai'
      }
    },
  },
  {
    key: 'OPENAI_MODEL',
    label: 'OpenAI model',
    sensitive: false,
    required: false,
    help: 'Overrides the default OpenAI model. No effect when using Anthropic.',
    placeholder: 'gpt-4o',
  },
]

/** One entry as Portainer reports it. Sensitive values come back masked. */
export interface ConfigEntry {
  key: string
  /** null for sensitive entries — Portainer never returns stored secrets. */
  value: string | null
  sensitive: boolean
  /** True when a sensitive entry holds a value, even though it is masked. */
  isSet?: boolean
}

export interface ConfigEntryInput {
  key: string
  value: string
  sensitive: boolean
}

/**
 * Whether Portainer holds a value. Accept either signal — never infer "not set"
 * from a missing `isSet`, which leads to overwriting a stored key.
 */
export function entryIsSet(entry: ConfigEntry | undefined): boolean {
  if (!entry) return false
  if (entry.isSet === true) return true
  return typeof entry.value === 'string' && entry.value.length > 0
}

// ─── Secret generation ───────────────────────────────────────────────────────

/** Generate an ENCRYPTION_KEY with the platform CSPRNG. */
export function generateEncryptionKey(): string {
  const bytes = new Uint8Array(ENCRYPTION_KEY_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** True when the runtime can generate secrets safely (needs a secure context). */
export function canGenerateSecrets(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  )
}

// ─── Portainer settings store ────────────────────────────────────────────────

async function readJson(res: Response) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      (data as { message?: string; error?: string })?.message ||
        (data as { error?: string })?.error ||
        `HTTP ${res.status}`,
    )
  }
  return data
}

/** List stored entries. Sensitive values are masked (`value: null`). */
export async function listConfig(): Promise<ConfigEntry[]> {
  const data = await readJson(await apiFetch(null, CONFIG_PATH))
  const entries = (data as { entries?: ConfigEntry[] })?.entries
  return Array.isArray(entries) ? entries : []
}

/** Replace the full entry set. */
export async function putConfig(entries: ConfigEntryInput[]): Promise<void> {
  await readJson(
    await apiFetch(null, CONFIG_PATH, {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
  )
}

/** Set or update a single entry. */
export async function patchConfigEntry(entry: ConfigEntryInput): Promise<void> {
  await readJson(
    await apiFetch(null, `${CONFIG_PATH}/${encodeURIComponent(entry.key)}`, {
      method: 'PATCH',
      body: JSON.stringify({ value: entry.value, sensitive: entry.sensitive }),
    }),
  )
}

/** Remove a single entry. */
export async function deleteConfigEntry(key: string): Promise<void> {
  await readJson(
    await apiFetch(null, `${CONFIG_PATH}/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),
  )
}

// ─── Portainer-Run setup state ───────────────────────────────────────────────

export interface SetupStatus {
  addonId: string
  setupRequired: boolean
  isAdmin: boolean
  canAdoptLocalKey: boolean
  keyStatus: 'unconfigured' | 'ok' | 'mismatch'
  affectedConnections: number
  gatewayPskStale: boolean
}

async function readServerJson(res: Response, what: string) {
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error || `HTTP ${res.status}`)
  }
  // Unknown backend routes fall through to index.html with a 200, which would
  // otherwise read as success. Same trap as deleteAppStack in gitTargets.js.
  if (!data || typeof data !== 'object') {
    throw new Error(
      `Unexpected response from ${what} — the endpoint may be missing or misrouted`,
    )
  }
  return data
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const data = await readServerJson(
    await serverFetch('/api/setup/status'),
    'setup status',
  )
  return data as SetupStatus
}

/** Import a hand-set key from the pod's environment; it never reaches the browser. */
export async function adoptLocalKey(): Promise<void> {
  await readServerJson(
    await serverFetch('/api/setup/adopt-key', { method: 'POST' }),
    'adopt-key',
  )
}

/**
 * Tell Portainer-Run to re-read its settings. Memory-only, so this is what makes
 * a save take effect. Returns whether it is configured afterwards.
 */
export async function reloadSettings(): Promise<boolean> {
  const data = (await readServerJson(
    await serverFetch('/api/setup/reload', { method: 'POST' }),
    'settings reload',
  )) as { setupRequired?: boolean }
  return data.setupRequired === false
}

/** Accept a changed key as the new baseline, abandoning data under the old one. */
export async function acknowledgeKeyChange(): Promise<void> {
  await readServerJson(
    await serverFetch('/api/setup/acknowledge-key-change', { method: 'POST' }),
    'acknowledge-key-change',
  )
}

// ─── Waiting out the re-apply ────────────────────────────────────────────────

export interface ServerConfigSnapshot {
  bootId?: string
  setupRequired?: boolean
  keyMismatch?: boolean
}

/** Current /config, or null while the pod is down mid-roll. */
export async function readServerConfig(): Promise<ServerConfigSnapshot | null> {
  try {
    const res = await serverFetch('/config')
    if (!res.ok) return null
    const data = await res.json()
    return data && typeof data === 'object' && typeof data.bootId === 'string'
      ? (data as ServerConfigSnapshot)
      : null
  } catch {
    return null
  }
}

const RESTART_POLL_MS = 2000

/**
 * Wait for the config change to actually be live.
 *
 * Saving re-applies the release, the chart rolls the pod on the secret/configmap
 * checksum change, and only the replacement pod sees the new env. A different
 * `bootId` is the proof — a 200 alone can still be the outgoing pod answering.
 *
 * Resolves 'restarted' on success and 'timeout' if the roll takes too long —
 * the save itself already succeeded either way, so this is informational.
 * 'unknown' means we never had a baseline to compare against and cannot tell.
 *
 * Short by default: nothing triggers a redeploy, so this only catches a restart
 * already in flight.
 */
export async function waitForRestart(
  previousBootId: string | undefined,
  timeoutMs = 15_000,
): Promise<'restarted' | 'timeout' | 'unknown'> {
  // Without a baseline, any response looks like a new pod. Say so rather than
  // reporting a restart we did not actually observe.
  if (!previousBootId) return 'unknown'
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RESTART_POLL_MS))
    const cfg = await readServerConfig()
    // null means the pod is mid-roll — exactly what we are waiting through.
    if (cfg?.bootId && cfg.bootId !== previousBootId) return 'restarted'
  }
  return 'timeout'
}
