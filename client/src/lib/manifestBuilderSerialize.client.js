/**
 * Client-side manifest builder serializer.
 * Uses the same logic as server/lib/manifestBuilderSerialize.js
 * but imports js-yaml from the client bundle.
 * Used by MBEditTab to serialize the updated form state to YAML
 * before committing via gitOpsUpdate.
 */
import yaml from 'js-yaml'
import { manifestBuilderToK8s } from './manifestBuilderToK8s.js'

export function serializeManifestBuilder(state, gitopsAnnotations) {
  // Inject gitops annotations into state so manifestBuilderToK8s includes them
  const stateWithAnnotations = {
    ...state,
    _gitopsAnnotations: gitopsAnnotations,
  }

  const manifests = manifestBuilderToK8s(stateWithAnnotations)

  return manifests
    .filter(Boolean)
    .map((m) => yaml.dump(m, { lineWidth: 120, noRefs: true }))
    .join('---\n')
}
