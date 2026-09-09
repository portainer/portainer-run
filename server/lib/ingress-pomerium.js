/**
 * Pomerium default-denies all traffic — every Ingress it fronts needs an
 * explicit access annotation or requests are blocked outright. This grants
 * the simplest baseline: any authenticated user, no per-app/per-team
 * restriction.
 */
export const POMERIUM_INGRESS_CLASS = 'pomerium'

/**
 * Extra annotations an app's Ingress needs when it's fronted by Pomerium —
 * empty for every other ingress class, so callers can always spread this
 * in unconditionally rather than branching themselves.
 *
 * @param {string} [ingressClass]
 * @returns {Record<string, string>}
 */
export function pomeriumAnnotations(ingressClass) {
  if (ingressClass !== POMERIUM_INGRESS_CLASS) return {}
  return { 'ingress.pomerium.io/allow_any_authenticated_user': 'true' }
}
