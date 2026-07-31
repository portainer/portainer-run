import yaml from 'js-yaml'

/**
 * Serialize one or more Kubernetes manifest objects to a multi-document YAML string.
 * Null/undefined entries are filtered out.
 *
 * @param {(object|null|undefined)[]} manifests
 * @returns {string}
 */
export function serializeManifests(manifests) {
  return manifests
    .filter(Boolean)
    .map((m) => yaml.dump(m, { lineWidth: 120, noRefs: true }))
    .join('---\n')
}

/**
 * Build the repo file path for an app's manifest.
 * @param {{ pathPrefix?: string, ns: string, appName: string }} p
 * @returns {string}  e.g. "apps/production/myapp.yaml"
 */
export function buildManifestPath({ pathPrefix, ns, appName }) {
  const parts = [pathPrefix, ns, `${appName}.yaml`].filter(Boolean)
  return parts.join('/')
}
