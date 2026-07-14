// Portainer-Run is served same-origin behind the Portainer addon gateway, so no
// cross-origin access needs to be granted. We deliberately emit NO
// Access-Control-Allow-Origin: a wildcard would expose responses (and, with the
// ambient session cookie, user data) to any origin. Non-browser clients (MCP,
// curl) are not subject to CORS. The object is kept so existing `...CORS`
// spreads and OPTIONS handling stay in place; add entries here only if a
// genuine cross-origin browser consumer is ever introduced.
export const CORS = {}
