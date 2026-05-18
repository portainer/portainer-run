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
  const clonedSpecs = containerSpecs.map((s) => JSON.parse(JSON.stringify(s)))
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
