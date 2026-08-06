import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
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
    const v = vParts
      .join('=')
      .trim()
      .replace(/^[\"']|[\"']$/g, '')
    process.env[k.trim()] = v
  }
}

export const PORTAINER_URL = (process.env.PORTAINER_URL || '').replace(
  /\/$/,
  '',
)
// AI keys, BASE_DOMAIN, GATEWAY_URL and ENCRYPTION_KEY are not read here: they
// come from Portainer at runtime and live in settings.js, which seeds itself
// from the same environment variables for local development.
// Plain HTTP only — TLS terminates at the proxy in front of us. Defaults to an
// unprivileged port so the container can run as a non-root user.
export const PORT = parseInt(process.env.PORT || '8080', 10)
export const CACHE_DIR = process.env.CACHE_DIR || path.join(projectRoot, 'data')

/** Release version, baked in at Docker build time. 'dev' for local/non-release builds. */
export const VERSION = process.env.PORTAINER_RUN_VERSION || 'dev'

/**
 * Unique to this process, so the setup UI can tell a restarted pod from the old
 * one still answering.
 */
export const BOOT_ID = crypto.randomUUID()

function resolveConfigNamespace() {
  // When running in Kubernetes, the pod's own namespace is mounted at this path automatically.
  try {
    const ns = fs
      .readFileSync(
        '/var/run/secrets/kubernetes.io/serviceaccount/namespace',
        'utf8',
      )
      .trim()
    if (ns) return ns
  } catch {
    /* not in Kubernetes */
  }
  // Explicit override, or kube-system for local/non-K8s runs.
  return process.env.CONFIG_NAMESPACE || 'kube-system'
}

export const CONFIG_NAMESPACE = resolveConfigNamespace()
export const CACHE_FILE = path.join(CACHE_DIR, 'cache.json')

export const DIST_DIR = path.join(projectRoot, 'client', 'dist')

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
  console.warn(
    '\n⚠️   No PORTAINER_URL in environment — the server cannot reach Portainer and all API requests will fail. Set PORTAINER_URL.\n',
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
