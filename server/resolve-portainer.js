import {
  PORTAINER_URL,
  portainerHost,
  portainerPort,
  portainerIsHttps,
} from './config.js'

/**
 * Target for outbound calls to the Portainer instance.
 * @typedef {{ host: string, port: number, isHttps: boolean, key: string }} PortainerTarget
 */

/**
 * Resolve the Portainer target from server-side configuration only.
 *
 * The target is deliberately NOT taken from any client-supplied header. Trusting
 * an inbound X-Portainer-URL would let a caller redirect the upstream request —
 * and the session cookie / API token attached to it — at an arbitrary host,
 * exfiltrating the user's Portainer credential and turning the server into an
 * SSRF gadget. In addon-gateway mode PORTAINER_URL is always set server-side.
 *
 * @returns {null | PortainerTarget}
 */
export function resolvePortainerTarget() {
  if (!PORTAINER_URL) return null
  return {
    host: portainerHost,
    port: portainerPort,
    isHttps: portainerIsHttps,
    key: PORTAINER_URL,
  }
}
