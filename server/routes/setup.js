/**
 * First-run setup support.
 *
 * The browser writes settings to Portainer itself over the admin's session.
 * This module covers only what a browser cannot do:
 *
 *   • adopt-key — import a hand-set ENCRYPTION_KEY into Portainer's store, so
 *     upgrades keep the same value. Only the pod can read its own environment.
 *   • acknowledge-key-change — clear a surfaced key-mismatch warning.
 *
 * Neither uses a Portainer-Run credential: adopt-key forwards the calling
 * admin's own token, as the deploy and Kubernetes paths already do.
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
      // A key already in our environment can be imported into Portainer's store
      // so it survives beyond this process.
      canAdoptLocalKey: isConfigured() && !settingsStatus().hydrated,
      keyStatus: continuity.status,
      affectedConnections: continuity.affectedConnections,
      gatewayPskStale: continuity.gatewayPskStale,
    })
    return true
  }

  // Every remaining route mutates state that is global to the installation.
  if (!caller.isAdmin) {
    json(res, 403, { error: 'Administrator access required' })
    return true
  }

  // Called by the setup screen right after it saves. Settings are held only in
  // memory, so this is what makes them live without waiting for a restart or
  // for the next admin request to hydrate opportunistically.
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
