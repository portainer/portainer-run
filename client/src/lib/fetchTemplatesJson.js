import { serverFetch } from './api.js'

/**
 * GET /templates — surfaces server JSON error body instead of bare "HTTP 502".
 * @returns {Promise<{ templates?: unknown[] } & Record<string, unknown>>}
 */
export async function fetchTemplatesJson() {
  const r = await serverFetch('/templates')
  const text = await r.text()
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(
      r.ok
        ? 'Invalid JSON from /templates'
        : `Could not load catalogue (HTTP ${r.status})`,
    )
  }
  if (!r.ok || j.error) {
    throw new Error(j.message || j.error || `HTTP ${r.status}`)
  }
  return j
}
