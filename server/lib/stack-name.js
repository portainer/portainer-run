/**
 * Portainer requires a Kubernetes stack name to be unique per environment *and*
 * namespace, compared case-insensitively — see checkUniqueStackNameInKubernetes,
 * which matches on EndpointID + Namespace + EqualFold(Name).
 *
 * It enforces that at stack-creation time, which for us is the last step of a
 * deploy: by then the manifest and source files are already committed to git and
 * the app's Secrets already exist in the cluster. Finding the clash up front turns
 * a half-finished deploy into a clean rejection.
 *
 * Note this is namespace-scoped, unlike an Ingress hostname — the same app name in
 * two namespaces is perfectly legal here.
 */

/** Portainer's StackType enum: 1 Swarm, 2 Compose, 3 Kubernetes. */
const KUBERNETES_STACK = 3

/**
 * Find a stack that already owns `name` in this environment and namespace.
 *
 * @param {object[]} stacks stacks as returned by GET /api/stacks
 * @param {{ envId: string|number, ns: string, name: string }} self
 * @returns {{ name: string } | null} the clashing stack, if any
 */
export function findStackNameConflict(stacks, self) {
  const wanted = String(self.name || '')
    .trim()
    .toLowerCase()
  if (!wanted) return null

  for (const stack of stacks || []) {
    if (stack?.Type !== KUBERNETES_STACK) continue
    // envId arrives from the query string as a string; Portainer reports a number.
    if (String(stack?.EndpointId ?? '') !== String(self.envId)) continue
    if ((stack?.Namespace || '') !== self.ns) continue

    // Portainer compares with EqualFold, so a stack created as "MyApp" in the
    // Portainer UI blocks a deploy named "myapp".
    const name = stack?.Name || ''
    if (name.toLowerCase() === wanted) return { name }
  }

  return null
}

/**
 * Message shown when a stack name is taken. Names the namespace, since the same
 * name is free in any other one.
 *
 * @param {{ name: string }} conflict
 * @param {string} ns
 */
export function stackNameConflictMessage(conflict, ns) {
  return (
    `An app named "${conflict.name}" already exists in project space "${ns}". ` +
    `Choose a different app name, or deploy into a different project space.`
  )
}
