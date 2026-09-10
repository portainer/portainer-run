/**
 * An app's public hostname is derived from its name alone (`<appName>.<baseDomain>`),
 * but app names are only unique within a namespace. Two same-named apps in different
 * namespaces therefore produce two Ingress objects claiming one hostname, and the
 * ingress controller serves whichever it admitted first — so the second app is
 * unreachable and its URL silently opens the first. These helpers find that clash
 * before anything is committed or deployed.
 *
 * Ingresses arrive as Portainer's K8sIngressInfo structs (capitalised `Name`,
 * `Namespace`, and a deduped `Hosts` array flattened from every `spec.rules[].host`),
 * not as raw Kubernetes objects.
 */

/** @param {string} host */
function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '') // a trailing dot is the same name in DNS
}

/**
 * Find an Ingress that already claims `host`, ignoring the app's own Ingress.
 *
 * @param {object[]} ingresses K8sIngressInfo structs from Portainer
 * @param {string} host hostname the app wants to claim
 * @param {{ ns: string, appName: string }} self the app being deployed or updated
 * @returns {{ name: string, namespace: string } | null} the clashing Ingress, if any
 */
export function findHostConflict(ingresses, host, self) {
  const wanted = normalizeHost(host)
  if (!wanted) return null

  for (const ingress of ingresses || []) {
    const name = ingress?.Name || ''
    const namespace = ingress?.Namespace || ''

    // The app's own Ingress is not a conflict — it is the one being replaced.
    if (name === self.appName && namespace === self.ns) continue

    const claimsHost = (ingress?.Hosts || []).some(
      (h) => normalizeHost(h) === wanted,
    )
    if (claimsHost) return { name, namespace }
  }

  return null
}

/**
 * Message shown when a hostname is taken. Names the owning app so the user knows
 * what they are colliding with rather than just that something went wrong.
 *
 * @param {string} host
 * @param {{ name: string, namespace: string }} conflict
 */
export function hostConflictMessage(host, conflict) {
  return (
    `Hostname ${host} is already used by app "${conflict.name}" in project space ` +
    `"${conflict.namespace}". Choose a different app name, or set an explicit hostname.`
  )
}
