/**
 * How this add-on trusts and bounds its calls to Portainer. Every outbound
 * client goes through portainerHttpRequest, so none can be left on weaker terms
 * than the others.
 */

import https from 'node:https'
import http from 'node:http'
import { portainerCA, portainerCAUnreadable } from '../machine-credential.js'

/** Without this, a blackholed Portainer hangs every request queued behind it. */
const READ_TIMEOUT_MS = 10_000

/**
 * A write can be Portainer cloning a repository and applying manifests inline,
 * which routinely outlasts a read.
 */
const WRITE_TIMEOUT_MS = 120_000

function timeoutFor(method) {
  return method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS
}

/**
 * A resumed TLS session skips the Certificate message, so getPeerCertificate()
 * comes back empty and the pin has nothing to match — failing exactly the
 * certificates the pin exists to accept. maxCachedSessions: 0 keeps every
 * handshake full; sockets are still pooled.
 */
const secureAgent = new https.Agent({ keepAlive: true, maxCachedSessions: 0 })

/**
 * Make a request to Portainer, verified and bounded.
 *
 * @param {{ host: string, port: number, isHttps: boolean }} target
 * @param {{ path: string, method: string, headers?: object, timeoutMs?: number }} options
 * @param {(res: import('http').IncomingMessage) => void} onResponse
 * @returns {import('http').ClientRequest}
 */
export function portainerHttpRequest(target, options, onResponse) {
  const { timeoutMs = timeoutFor(options.method), ...rest } = options
  const transport = target.isHttps ? https : http

  const req = transport.request(
    {
      hostname: target.host,
      port: target.port,
      ...rest,
      ...tlsOptions(target),
    },
    onResponse,
  )

  // A certificate that exists but will not open leaves nothing to verify
  // against, so the token must not go out over that connection.
  if (target.isHttps && portainerCAUnreadable()) {
    const err = new Error(
      'The published Portainer certificate cannot be read, so this connection cannot be verified',
    )
    err.code = 'PORTAINER_CERT_UNREADABLE'
    req.destroy(err)

    return req
  }

  bound(req, timeoutMs)
  verifyOnConnect(req)

  return req
}

/**
 * Connection options for a call to Portainer. verifyPeer decides, not the
 * handshake: OpenSSL will not treat a leaf as a trust anchor — no
 * X509_V_FLAG_PARTIAL_CHAIN — so demanding a verified chain rejects the
 * ordinary case of a certificate file holding just the serving certificate.
 */
function tlsOptions(target) {
  if (!target.isHttps) return {}

  const ca = portainerCA()

  return ca
    ? { ca, rejectUnauthorized: false, agent: secureAgent }
    : { rejectUnauthorized: false, agent: secureAgent }
}

/**
 * Bound the whole call, not one phase of it.
 *
 * req.setTimeout cannot: Node defers arming it until the socket emits
 * 'connect', so a peer that drops the SYN is never bounded, and on TLS it arms
 * on both the TCP and the TLS socket so it fires at twice the value asked for.
 *
 * This bounds total duration where req.setTimeout bounds inactivity. Every call
 * here reads one buffered response, so nothing arrives in instalments for an
 * inactivity timer to distinguish.
 */
function bound(req, timeoutMs) {
  const timer = setTimeout(() => {
    const err = new Error('Portainer did not respond in time')
    err.code = 'PORTAINER_TIMEOUT'
    req.destroy(err)
  }, timeoutMs)
  timer.unref()

  req.on('close', () => clearTimeout(timer))
}

/**
 * Verify Portainer's certificate once the handshake completes.
 *
 * Nothing is written before this runs: Node emits secureConnect before the
 * request is flushed, so a rejected peer never sees the token.
 */
function verifyOnConnect(req) {
  req.on('socket', (socket) => {
    // A pooled socket was verified when it was opened; listening again adds a
    // listener per request that can never fire.
    if (!socket.encrypted || !socket.connecting) return

    socket.once('secureConnect', () => verifyPeer(req, socket))
  })
}

/**
 * Accepted on either of two grounds: the certificate is the one published with
 * the credential, identified by its own bytes, or it verifies normally against
 * the published one. The second admits a renewal only where the published file
 * carries the issuer; against a published leaf alone, a renewed certificate is
 * rejected until Portainer republishes it.
 */
function verifyPeer(req, socket) {
  // Nothing published to verify against; warnUnverified says so at startup.
  const ca = portainerCA()
  if (!ca) return

  // Validity dates are not checked here. They bound how long a chain vouches
  // for a binding this does not rely on, and expiry has no republishing of its
  // own — a Repair would hand back the same certificate, with no way out.
  const leaf = socket.getPeerCertificate(false)?.raw
  if (leaf && publishedCertificates(ca).some((der) => der.equals(leaf))) return

  if (socket.authorized) return

  const err = new Error(
    "Portainer's TLS certificate is neither the one published with the add-on " +
      `credential nor verifiable against it (${socket.authorizationError}). ` +
      'Repairing the credential republishes the certificate Portainer is currently serving.',
  )
  // Carries CERT so failureCause reads it as a credential fault rather than an
  // unexplained transport error.
  err.code = 'PORTAINER_CERT_UNTRUSTED'
  req.destroy(err)
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

/** Report at startup where HTTPS calls stand. */
export function warnUnverified(isHttps) {
  if (!isHttps) return

  if (portainerCAUnreadable()) {
    console.warn(
      '⚠️  The mounted Portainer certificate cannot be read: calls to Portainer will be refused.',
    )
    return
  }

  if (portainerCA()) return

  console.warn(
    '⚠️  No Portainer certificate is mounted: HTTPS calls to Portainer are not verified.',
  )
}
