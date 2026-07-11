import yaml from 'js-yaml'

// Pod Security Standards (issue #39). Kept in sync with the vibe deploy path in
// routes/vibe.js. Applied to every container in the pod plus the pod itself.
const CONTAINER_SECURITY_CONTEXT = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
}
const POD_SECURITY_CONTEXT = {
  seccompProfile: { type: 'RuntimeDefault' },
}

/**
 * Normalize a Kubernetes quantity string.
 * Converts common mistakes to valid suffixes and validates the result.
 * Returns null if the value is empty/missing.
 * Throws if the value is non-empty but unrecognisable.
 *
 * Valid CPU:    "100m", "0.5", "1", "2"
 * Valid memory: "128Mi", "512Mi", "1Gi", "256Ki"
 */
export function normalizeQuantity(value, type = 'memory') {
  if (!value || !String(value).trim()) return null
  let v = String(value).trim()

  // Common wrong suffixes → correct
  const memMap = { mb: 'Mi', gb: 'Gi', kb: 'Ki', tb: 'Ti', mib: 'Mi', gib: 'Gi', kib: 'Ki' }
  const lv = v.toLowerCase()
  for (const [wrong, right] of Object.entries(memMap)) {
    if (lv.endsWith(wrong)) {
      v = v.slice(0, v.length - wrong.length) + right
      break
    }
  }

  // Bare integer with no suffix for memory — assume Mi
  if (type === 'memory' && /^\d+$/.test(v)) {
    v = v + 'Mi'
  }

  // Validate: Kubernetes quantity regex
  // CPU: digits optionally followed by 'm', or decimal
  // Memory: digits followed by Ki/Mi/Gi/Ti/Pi/Ei or K/M/G/T/P/E or bare number
  const valid = /^(\d+(\.\d+)?m?|(\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?))$/.test(v)
  if (!valid) {
    throw new Error(`Invalid ${type} quantity: "${value}". Use values like 100m, 500m (CPU) or 128Mi, 1Gi (memory).`)
  }

  return v
}



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
 * Build the full set of Kubernetes manifests for a portainer-run deployment.
 *
 * Accepts the same parameters that `executeDeploy` in deployK8s.js receives,
 * plus the GitOps annotation fields. Returns an array of manifest objects
 * ready for serialization.
 *
 * @param {object} p
 * @param {string} p.appName
 * @param {string} p.ns           namespace
 * @param {number} p.instances    replica count
 * @param {object[]} p.containerSpecs  pre-built K8s container specs (from buildK8sContainer)
 * @param {string[]} p.containerRowIds
 * @param {{ name, size, storageClass?, mountPath, containerId }[]} p.volumeDefs
 * @param {'none'|'NodePort'|'LoadBalancer'|'Ingress'} p.exposeType
 * @param {number[]} p.servicePorts
 * @param {{ host?, path?, port?, ingressClass? }} p.ingress
 * @param {object} p.gitopsAnnotations  { gitTargetId, gitBranch, gitPath }
 * @returns {object[]}  array of K8s manifest objects (some may be null — caller should filter)
 */
export function buildManifests({
  appName,
  ns,
  instances,
  containerSpecs,
  containerRowIds,
  volumeDefs,
  exposeType,
  servicePorts,
  ingress,
  gitopsAnnotations,
}) {
  // Attach volumeMounts to the right container spec (same logic as executeDeploy)
  const idToSpec = new Map(containerRowIds.map((id, i) => [id, containerSpecs[i]]))
  // Deep-clone specs so we don't mutate the originals
  const clonedSpecs = containerSpecs.map((s) => {
    const spec = JSON.parse(JSON.stringify(s))
    if (spec.resources) {
      const r = spec.resources
      if (r.requests) {
        if (r.requests.cpu != null) r.requests.cpu = normalizeQuantity(r.requests.cpu, 'cpu') || undefined
        if (r.requests.memory != null) r.requests.memory = normalizeQuantity(r.requests.memory, 'memory') || undefined
        if (!r.requests.cpu && !r.requests.memory) delete spec.resources.requests
      }
      if (r.limits) {
        if (r.limits.cpu != null) r.limits.cpu = normalizeQuantity(r.limits.cpu, 'cpu') || undefined
        if (r.limits.memory != null) r.limits.memory = normalizeQuantity(r.limits.memory, 'memory') || undefined
        if (!r.limits.cpu && !r.limits.memory) delete spec.resources.limits
      }
    }
    // Pod Security Standards (issue #39): harden every container, preserving
    // any securityContext keys already present on the spec.
    spec.securityContext = { ...CONTAINER_SECURITY_CONTEXT, ...(spec.securityContext || {}) }
    return spec
  })
  const clonedIdToSpec = new Map(containerRowIds.map((id, i) => [id, clonedSpecs[i]]))

  for (const v of volumeDefs) {
    const spec = clonedIdToSpec.get(v.containerId)
    if (spec) {
      spec.volumeMounts = [{ name: v.name, mountPath: v.mountPath }]
    }
  }

  const podVolumes = volumeDefs.map((v) => ({
    name: v.name,
    persistentVolumeClaim: { claimName: v.name },
  }))

  // Annotations for GitOps round-trip
  const annotations = {
    'portainer-run/git-target-id': gitopsAnnotations.gitTargetId,
    'portainer-run/git-branch': gitopsAnnotations.gitBranch,
    'portainer-run/git-path': gitopsAnnotations.gitPath,
  }

  const manifests = []

  // PVCs — one per volume
  for (const v of volumeDefs) {
    manifests.push({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: v.name,
        namespace: ns,
        labels: { app: appName, 'managed-by': 'portainer-run' },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: v.size } },
        ...(v.storageClass ? { storageClassName: v.storageClass } : {}),
      },
    })
  }

  // Deployment
  manifests.push({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: appName,
      namespace: ns,
      labels: { app: appName, 'managed-by': 'portainer-run' },
      annotations,
    },
    spec: {
      replicas: instances,
      selector: { matchLabels: { app: appName } },
      template: {
        metadata: { labels: { app: appName, 'managed-by': 'portainer-run' } },
        spec: {
          securityContext: POD_SECURITY_CONTEXT,
          automountServiceAccountToken: false,
          containers: clonedSpecs,
          ...(podVolumes.length ? { volumes: podVolumes } : {}),
        },
      },
    },
  })

  // Service + optional Ingress
  if (exposeType && exposeType !== 'none') {
    if (exposeType === 'NodePort' || exposeType === 'LoadBalancer') {
      const ports = servicePorts.length ? servicePorts : [80]
      manifests.push({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: appName,
          namespace: ns,
          labels: { app: appName, 'managed-by': 'portainer-run' },
        },
        spec: {
          selector: { app: appName },
          type: exposeType,
          ports: ports.map((p) => ({
            name: 'port-' + p,
            port: p,
            targetPort: p,
            protocol: 'TCP',
          })),
        },
      })
    }

    if (exposeType === 'Ingress') {
      const { host, path: iPath, port: iPort, ingressClass: iClass } = ingress

      manifests.push({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: appName,
          namespace: ns,
          labels: { app: appName, 'managed-by': 'portainer-run' },
        },
        spec: {
          selector: { app: appName },
          type: 'ClusterIP',
          ports: [{ port: iPort, targetPort: iPort, protocol: 'TCP' }],
        },
      })

      const ingressMeta = {
        name: appName,
        namespace: ns,
        labels: { app: appName, 'managed-by': 'portainer-run' },
        ...(iClass ? { annotations: { 'kubernetes.io/ingress.class': iClass } } : {}),
      }

      manifests.push({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: ingressMeta,
        spec: {
          ...(iClass ? { ingressClassName: iClass } : {}),
          rules: [
            {
              ...(host ? { host } : {}),
              http: {
                paths: [
                  {
                    path: iPath || '/',
                    pathType: 'Prefix',
                    backend: {
                      service: { name: appName, port: { number: iPort } },
                    },
                  },
                ],
              },
            },
          ],
        },
      })
    }
  }

  return manifests
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
