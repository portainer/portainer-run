/**
 * First-run setup. The browser writes settings to Portainer itself; this covers
 * what it cannot do — reloading this process's settings, importing a hand-set
 * key from the pod's own environment, and clearing a key-mismatch warning.
 *
 * Writes forward the calling admin's own token even where this add-on has a
 * credential: adopting a key is a deliberate act, and Portainer records who.
 */

import { CORS } from '../lib/cors.js'
import {
  encryptionKey,
  ensureHydrated,
  hydrate,
  isConfigured,
  settingsStatus,
} from '../settings.js'
import { resolveCallerIdentity } from '../lib/identity.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'
import { portainerRequest } from '../lib/portainer-api.js'
import { keyContinuity, acknowledgeKeyChange } from '../lib/key-continuity.js'

/** This addon's id in Portainer's addon registry (see client/src/lib/getAddons.ts). */
export const ADDON_ID = 'portainer-run'

const ENCRYPTION_KEY_ENTRY = 'ENCRYPTION_KEY'

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

/**
 * Handle all /api/setup/* routes.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<true | null>} true when handled, null to fall through
 */
export async function handleSetup(req, res, pathname) {
  const caller = await resolveCallerIdentity(req)
  if (!caller) {
    json(res, 401, { error: 'Unauthorized' })
    return true
  }

  if (pathname === '/api/setup/status' && req.method === 'GET') {
    const continuity = keyContinuity()
    json(res, 200, {
      addonId: ADDON_ID,
      setupRequired: !isConfigured(),
      isAdmin: caller.isAdmin,
      settings: settingsStatus(),
      // A key in our environment can be imported so it outlives this process.
      canAdoptLocalKey: isConfigured() && !settingsStatus().hydrated,
      keyStatus: continuity.status,
      affectedConnections: continuity.affectedConnections,
      gatewayPskStale: continuity.gatewayPskStale,
    })
    return true
  }

  // The rest mutate installation-wide state.
  if (!caller.isAdmin) {
    json(res, 403, { error: 'Administrator access required' })
    return true
  }

  // Called by the setup screen after saving: settings are memory-only, so this
  // is what makes them live.
  if (pathname === '/api/setup/reload' && req.method === 'POST') {
    const ok = await hydrate(caller.token)
    json(res, ok ? 200 : 502, {
      ok,
      setupRequired: !isConfigured(),
      settings: settingsStatus(),
    })
    return true
  }

  if (pathname === '/api/setup/adopt-key' && req.method === 'POST') {
    if (!isConfigured()) {
      json(res, 400, {
        error:
          'This instance has no ENCRYPTION_KEY to import. Generate one in setup instead.',
      })
      return true
    }
    const target = resolvePortainerTarget()
    if (!target) {
      json(res, 400, {
        error: 'Server is misconfigured: PORTAINER_URL is not set.',
      })
      return true
    }
    try {
      await portainerRequest(
        target,
        caller.token,
        'PATCH',
        `/api/addons/${ADDON_ID}/config/${ENCRYPTION_KEY_ENTRY}`,
        JSON.stringify({ value: encryptionKey(), sensitive: true }),
      )
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      // Never echo the key or a message that might embed it.
      console.error('[setup] adopt-key failed:', err.message)
      json(res, err.status === 403 ? 403 : 502, {
        error: 'Could not save the existing key to Portainer.',
      })
      return true
    }
    // Deliberately no key material in the response.
    json(res, 200, { ok: true, adopted: ENCRYPTION_KEY_ENTRY })
    return true
  }

  if (
    pathname === '/api/setup/acknowledge-key-change' &&
    req.method === 'POST'
  ) {
    const continuity = acknowledgeKeyChange()
    json(res, 200, { ok: true, keyStatus: continuity.status })
    return true
  }

  return null
}
