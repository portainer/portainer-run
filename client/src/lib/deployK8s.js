import { apiFetch } from './api.js'
import { inflightDedupe } from './inflightDedupe.js'

/**
 * @param {string} token
 * @param {string} envId
 * @returns {Promise<{ ok: true, manual: boolean, namespaces: string[], message?: string } | { ok: false, error: string, manual?: boolean }>}
 */
export async function fetchNamespaceOptions(token, envId) {
  return inflightDedupe(`k8s:ns-options:${envId}`, async () => {
    const r = await apiFetch(token, `/kubernetes/${envId}/namespaces`)
    if (r.status === 403 || r.status === 401) {
      return {
        ok: true,
        manual: true,
        namespaces: [],
        message: 'Token is namespace-scoped — enter your namespace below.',
      }
    }
    if (!r.ok) {
      return {
        ok: false,
        error: 'Could not fetch namespaces: HTTP ' + r.status,
        manual: true,
      }
    }
    const list = await r.json().catch(() => [])
    const accessible = (Array.isArray(list) ? list : []).map((n) => n.Name)
    if (!accessible.length) {
      return {
        ok: true,
        manual: true,
        namespaces: [],
        message: 'No accessible namespaces found — enter manually below.',
      }
    }
    return {
      ok: true,
      manual: false,
      namespaces: accessible,
      message: accessible.length + ' accessible namespace(s)',
    }
  })
}
