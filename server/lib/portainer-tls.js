/**
 * How this add-on trusts and bounds its calls to Portainer. Shared by every
 * outbound client, so none can be left on weaker terms than the others.
 */

import tls from 'node:tls'
import { portainerCA } from '../machine-credential.js'

/** Without this, a blackholed Portainer hangs every request queued behind it. */
export const PORTAINER_TIMEOUT_MS = 10_000

/**
 * Verify Portainer against the certificate it published with the credential.
 *
 * The hostname check cannot be turned off for a certificate that does not
 * name the in-cluster service. Node treats every certificate in `ca` as a
 * trust anchor, and Portainer publishes whatever serves its TLS — often a chain
 * including a public intermediate — so skipping it would accept anything that
 * issuer ever signed, for any domain.
 *
 * So a mismatch is allowed only for the certificate we were handed: a renewed
 * one is still checked against its SANs, and one merely sharing an issuer is
 * rejected.
 */
export function portainerTlsOptions() {
  const ca = portainerCA()
  if (!ca) return { rejectUnauthorized: false }

  const published = publishedCertificates(ca)

  return {
    ca,
    rejectUnauthorized: true,
    checkServerIdentity: (hostname, cert) =>
      published.some((der) => der.equals(cert.raw))
        ? undefined
        : tls.checkServerIdentity(hostname, cert),
  }
}

function publishedCertificates(pem) {
  const blocks =
    pem
      .toString('utf8')
      .match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? []

  return blocks.map((block) =>
    Buffer.from(
      block.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
      'base64',
    ),
  )
}

/** Fail a request Portainer never answers, like any other transport error. */
export function boundRequest(req) {
  req.setTimeout(PORTAINER_TIMEOUT_MS, () =>
    req.destroy(new Error('Portainer did not respond in time')),
  )

  return req
}
