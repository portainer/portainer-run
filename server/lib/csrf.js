/**
 * CSRF defence for state-changing requests.
 *
 * Portainer-Run authenticates the browser via the ambient Portainer session
 * cookie, which the browser attaches automatically — the classic prerequisite
 * for CSRF. We reject any unsafe-method request that the browser itself marks
 * as coming from another site, using the Fetch Metadata `Sec-Fetch-Site`
 * header. Browsers set this header and page JavaScript cannot forge it.
 *
 * Non-browser clients (the MCP server, curl) do not send `Sec-Fetch-Site` and
 * authenticate with an explicit API token rather than the ambient cookie, so an
 * attacker cannot ride their credentials cross-site. Those requests are allowed
 * through when the header is absent.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean} true when the request should be blocked as cross-site
 */
export function isCrossSiteRequest(req) {
  const site = req.headers['sec-fetch-site']
  if (!site) return false
  return site !== 'same-origin' && site !== 'none'
}
