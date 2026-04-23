import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Repo root (parent of /server) */
export const projectRoot = path.join(__dirname, '..')

const envFile = path.join(projectRoot, '.env')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const [k, ...vParts] = t.split('=')
    if (!k?.trim() || process.env[k.trim()]) continue
    const v = vParts.join('=').trim().replace(/^["']|["']$/g, '')
    process.env[k.trim()] = v
  }
}

export const PORTAINER_URL = (process.env.PORTAINER_URL || '').replace(/\/$/, '')
export const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''
export const OPENAI_KEY = process.env.OPENAI_API_KEY || ''
export const AI_PROVIDER =
  process.env.AI_PROVIDER || (ANTHROPIC_KEY ? 'anthropic' : OPENAI_KEY ? 'openai' : '')
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o'
export const PORT = parseInt(process.env.PORT || '443', 10)
export const HTTP_PORT = parseInt(process.env.HTTP_PORT || '80', 10)
export const SSL_CERT_PATH = process.env.SSL_CERT || ''
export const SSL_KEY_PATH = process.env.SSL_KEY || ''
export const CERT_DIR = process.env.SSL_CERT_DIR || projectRoot
export const CACHE_DIR = process.env.CACHE_DIR || path.join(projectRoot, 'data')
export const TEMPLATE_URL =
  process.env.TEMPLATE_URL ||
  'https://raw.githubusercontent.com/portainer/portainer-run/refs/heads/develop/templates.json'
export const BASE_DOMAIN = process.env.BASE_DOMAIN || ''
export const CACHE_FILE = path.join(CACHE_DIR, 'cache.json')
export const DIST_DIR = path.join(projectRoot, 'client', 'dist')
export const LEGACY_HTML = path.join(
  projectRoot,
  'old-implementation',
  'portainer-run.html',
)

if (PORTAINER_URL) {
  let _valid = true
  try {
    new URL(PORTAINER_URL)
  } catch {
    _valid = false
  }
  if (!_valid) {
    console.error(`\n❌  Invalid PORTAINER_URL: "${PORTAINER_URL}"\n`)
    process.exit(1)
  }
} else {
  console.log(
    '\nℹ️  No PORTAINER_URL in environment — the browser will send the instance URL (X-Portainer-URL) on each request.\n'
  )
}

if (!ANTHROPIC_KEY && !OPENAI_KEY) {
  console.warn(
    '\n⚠️   No AI key set (ANTHROPIC_API_KEY or OPENAI_API_KEY) — AI triage will be unavailable\n'
  )
}

/** Set only when `PORTAINER_URL` is non-empty. */
const pOrigin = PORTAINER_URL ? new URL(PORTAINER_URL) : null
export const portainerHost = pOrigin ? pOrigin.hostname : ''
export const portainerPort = pOrigin
  ? pOrigin.port
    ? parseInt(pOrigin.port, 10)
    : pOrigin.protocol === 'https:'
      ? 443
      : 80
  : 0
export const portainerIsHttps = pOrigin ? pOrigin.protocol === 'https:' : true
