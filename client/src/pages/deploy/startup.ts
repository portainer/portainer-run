// ---------------------------------------------------------------------------
// Startup progress (deploy → starting → ready)
// ---------------------------------------------------------------------------

export const STARTUP_POLL_MS = 3000
// Vibe apps run npm/pip installs in init containers, so first boot can be slow.
export const STARTUP_TIMEOUT_MS = 5 * 60 * 1000

export type StartupPhase = 'deploying' | 'starting' | 'ready' | 'error' | 'timeout'

// Mirrors sanitizeStackName in server/routes/vibe.js: the deployment name and
// `app` label are derived from the entered app name, so we must match them when
// polling for readiness.
export function sanitizeAppName(name: string) {
  return name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

// A subset of the human-friendly reasons from server/env-status.js that mean the
// app cannot recover on its own — surfacing these lets us stop waiting early.
export function isBlockingReason(reason: string | null): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return (
    r.includes('keeps crashing') ||
    r.includes('download the image') ||
    r.includes('image name is invalid') ||
    r.includes('failed to start') ||
    r.includes('missing config') ||
    r.includes('memory limit') ||
    r.includes('exiting with errors')
  )
}
