/**
 * An app's Ingress gets no `tls:` block of its own today — it depends
 * entirely on whatever cluster-wide default certificate the ingress
 * controller happens to provide, which isn't consistent across controllers.
 *
 * Deliberately doesn't read or cache a certificate anywhere: it only checks,
 * at deploy time, whether a Secret with this well-known name already exists
 * in the app's own namespace, and references it if so. Getting that Secret
 * into a namespace in the first place is a separate concern this module
 * knows nothing about.
 *
 * Must match `secretName` in the installer's own `internal/stages/tls/tls.go`
 * exactly — there's no shared code enforcing this across the two repos, so
 * the name is a manual cross-repo contract.
 */
export const WILDCARD_TLS_SECRET_NAME = 'portainer-run-wildcard-tls'

/**
 * The `spec.tls` value for an Ingress that should use the wildcard secret.
 *
 * @param {string} host
 * @returns {{ hosts: string[], secretName: string }[]}
 */
export function wildcardTlsBlock(host) {
  return [{ hosts: [host], secretName: WILDCARD_TLS_SECRET_NAME }]
}
