/**
 * Whether this add-on's own credential still works, as every call to Portainer
 * finds out. Kept out of settings, which stop calling once hydrated.
 */

/** @typedef {'rejected' | 'certificate'} Fault */

/** @type {Fault | null} */
let fault = null

/** @returns {Fault | null} */
export function credentialFailure() {
  return fault
}

/**
 * What one call to Portainer proves about the credential.
 *
 * A rejection counts only where the add-on presented its own credential; a
 * certificate counts whoever called, since the pin is on the certificate
 * rather than the token. 401 only: the machine API answers 401 for every
 * authentication failure, so a 403 is a credential Portainer knows.
 *
 * @param {{
 *   usedMachineCredential?: boolean,
 *   status?: number | null,
 *   certificateTrusted?: boolean | null,
 * }} outcome
 * @returns {{ record: Fault } | { clear: 'all' | 'certificate' } | null}
 */
export function classifyOutcome({
  usedMachineCredential = false,
  status = null,
  certificateTrusted = null,
}) {
  if (certificateTrusted === false) {
    return { record: 'certificate' }
  }

  if (certificateTrusted === true) return { clear: 'certificate' }

  // Unreachable says nothing about the credential.
  if (status === null) return null

  if (status === 401) {
    return usedMachineCredential ? { record: 'rejected' } : null
  }

  // Anything else says nothing, so it must not clear a known rejection.
  if (status >= 400) return null

  return { clear: usedMachineCredential ? 'all' : 'certificate' }
}

/** Apply what a call proved. @param {Parameters<typeof classifyOutcome>[0]} outcome */
export function noteOutcome(outcome) {
  const verdict = classifyOutcome(outcome)
  if (!verdict) return

  if ('record' in verdict) {
    fault = verdict.record
    return
  }

  if (verdict.clear === 'all' || fault === 'certificate') fault = null
}
