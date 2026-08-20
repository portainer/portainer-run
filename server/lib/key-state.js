/**
 * The encryption key verdict, decided from a snapshot of the volume.
 *
 * No database access: key-continuity.js reads the snapshot and passes it in.
 */

/**
 * @typedef {object} KeyContinuity
 * @property {'unconfigured'|'ok'|'mismatch'|'lost'} status
 *   `lost` — no key but encrypted data exists. Never a first run.
 * @property {number} affectedConnections  Git targets that will no longer decrypt.
 * @property {boolean} gatewayPskStale     Whether the registered gateway PSK is orphaned.
 */

/**
 * @typedef {object} KeyState
 * @property {boolean} configured    Whether a usable key is held.
 * @property {string | null} stored  Fingerprint recorded on this volume.
 * @property {string | null} current Fingerprint of the key held now.
 * @property {number} encryptedRows
 * @property {boolean} gatewayPsk
 */

/**
 * @param {KeyState} state
 * @returns {KeyContinuity & {rebaseline: boolean}} `rebaseline` asks the caller
 * to record the current key as the new baseline.
 */
export function classifyKeyState({
  configured,
  stored,
  current,
  encryptedRows,
  gatewayPsk,
}) {
  if (!configured) {
    // Rows, not the fingerprint: 1.3.0 never recorded one, so gating on it
    // reads the upgrade that loses the key as a first run.
    if (encryptedRows > 0 || gatewayPsk) {
      return {
        status: 'lost',
        affectedConnections: encryptedRows,
        gatewayPskStale: gatewayPsk,
        rebaseline: false,
      }
    }
    return {
      status: 'unconfigured',
      affectedConnections: 0,
      gatewayPskStale: false,
      rebaseline: false,
    }
  }

  // First boot on this volume, or the expected steady state.
  if (!stored || stored === current) {
    return {
      status: 'ok',
      affectedConnections: 0,
      gatewayPskStale: false,
      rebaseline: !stored,
    }
  }

  // Nothing encrypted behind it, so the change costs nothing. Adopt silently.
  if (encryptedRows === 0 && !gatewayPsk) {
    return {
      status: 'ok',
      affectedConnections: 0,
      gatewayPskStale: false,
      rebaseline: true,
    }
  }

  return {
    status: 'mismatch',
    affectedConnections: encryptedRows,
    gatewayPskStale: gatewayPsk,
    rebaseline: false,
  }
}
