import { kubeFetch } from './api.js'

export const GPU_RESOURCE_KEYS = [
  'nvidia.com/gpu',
  'amd.com/gpu',
  'gpu.intel.com/i915',
  'habana.ai/gaudi',
]

/**
 * @param {string} token
 * @param {string} envId
 * @returns {Promise<{ ok: true, manual: boolean, namespaces: string[], message?: string } | { ok: false, error: string, manual?: boolean }>}
 */
export async function fetchNamespaceOptions(token, envId) {
  const r = await kubeFetch(token, envId, '/api/v1/namespaces')
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
  const allNss = (await r.json()).items.map((n) => n.metadata.name)
  const accessible = (
    await Promise.all(
      allNss.map(async (ns) => {
        const pr = await kubeFetch(
          token,
          envId,
          `/apis/apps/v1/namespaces/${ns}/deployments?limit=1`,
        )
        return pr.ok ? ns : null
      }),
    )
  ).filter(Boolean)
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
}

/**
 * @param {string} token
 * @param {string} envId
 */
export async function fetchStorageClasses(token, envId) {
  const r = await kubeFetch(token, envId, '/apis/storage.k8s.io/v1/storageclasses')
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return (await r.json()).items || []
}

/**
 * @param {string} token
 * @param {string} envId
 * @param {string} ns
 */
export async function fetchSecretsInNamespace(token, envId, ns) {
  if (!ns) return []
  const r = await kubeFetch(token, envId, `/api/v1/namespaces/${ns}/secrets`)
  if (!r.ok) return []
  return (await r.json()).items || []
}

/**
 * @param {string} token
 * @param {string} envId
 * @returns {Promise<{ key: string, label: string, warn?: 'amber' | 'green' }>}
 */
export async function detectClusterGpuType(token, envId) {
  if (!envId) return { key: 'nvidia.com/gpu', label: 'Select an environment first' }
  const r = await kubeFetch(token, envId, '/api/v1/nodes')
  if (!r.ok) {
    return { key: 'nvidia.com/gpu', label: 'Could not detect GPU type' }
  }
  const nodes = (await r.json()).items || []
  const typeCounts = {}
  for (const node of nodes) {
    const alloc = node.status?.allocatable || {}
    for (const k of GPU_RESOURCE_KEYS) {
      const n = parseInt(alloc[k] || '0', 10)
      if (n > 0) typeCounts[k] = (typeCounts[k] || 0) + n
    }
  }
  if (!Object.keys(typeCounts).length) {
    return {
      key: 'nvidia.com/gpu',
      label: '⚠ No GPU nodes in this environment',
      warn: 'amber',
    }
  }
  const topKey = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0]
  const total = Object.values(typeCounts).reduce((a, b) => a + b, 0)
  return {
    key: topKey,
    label: `${total} GPU(s) available · ${topKey}`,
    warn: 'green',
  }
}

/**
 * @param {string} token
 * @param {object} p
 * @param {string} p.envId
 * @param {string} p.ns
 * @param {string} p.appName
 * @param {number} p.instances
 * @param {object[]} p.containerSpecs — Kubernetes container objects (ordered)
 * @param {{ containerId: string, name: string, storageClass?: string, size: string, mountPath: string }[]} p.volumeDefs
 * @param {string} p.exposeType
 * @param {number[]} p.servicePorts
 * @param {{ host: string, path: string, port: number, ingressClass: string }} p.ingress
 * @param {string[]} p.containerRowIds — same length as `containerSpecs`; `volumeDefs[].containerId` must match
 */
export async function executeDeploy(
  token,
  {
    envId,
    ns,
    appName,
    instances,
    containerSpecs,
    volumeDefs,
    exposeType,
    servicePorts,
    ingress,
    containerRowIds,
  },
) {
  const idToSpec = new Map(containerRowIds.map((id, i) => [id, containerSpecs[i]]))
  for (const v of volumeDefs) {
    const spec = idToSpec.get(v.containerId)
    if (spec) {
      spec.volumeMounts = [{ name: v.name, mountPath: v.mountPath }]
    }
  }

  const podVolumes = volumeDefs.map((v) => ({
    name: v.name,
    persistentVolumeClaim: { claimName: v.name },
  }))

  for (const { name: volName, size, storageClass } of volumeDefs) {
    const pvcManifest = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: volName,
        namespace: ns,
        labels: { app: appName, 'managed-by': 'portainer-run' },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: size } },
        ...(storageClass ? { storageClassName: storageClass } : {}),
      },
    }
    const pr = await kubeFetch(token, envId, `/api/v1/namespaces/${ns}/persistentvolumeclaims`, {
      method: 'POST',
      body: JSON.stringify(pvcManifest),
    })
    if (!pr.ok && pr.status !== 409) {
      const j = await pr.json().catch(() => ({}))
      throw new Error(`Volume "${volName}" failed: ` + (j?.message || 'HTTP ' + pr.status))
    }
  }

  const depManifest = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: appName,
      namespace: ns,
      labels: { app: appName, 'managed-by': 'portainer-run' },
    },
    spec: {
      replicas: instances,
      selector: { matchLabels: { app: appName } },
      template: {
        metadata: { labels: { app: appName, 'managed-by': 'portainer-run' } },
        spec: {
          containers: containerSpecs,
          ...(podVolumes.length ? { volumes: podVolumes } : {}),
        },
      },
    },
  }

  const r = await kubeFetch(token, envId, `/apis/apps/v1/namespaces/${ns}/deployments`, {
    method: 'POST',
    body: JSON.stringify(depManifest),
  })
  if (r.status === 409) {
    throw new Error('A deployment with this name already exists in namespace "' + ns + '".')
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw new Error(j?.message || 'HTTP ' + r.status)
  }

  if (exposeType === 'NodePort' || exposeType === 'LoadBalancer') {
    const ports = servicePorts.length ? servicePorts : [80]
    const svcManifest = {
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
    }
    const sr = await kubeFetch(token, envId, `/api/v1/namespaces/${ns}/services`, {
      method: 'POST',
      body: JSON.stringify(svcManifest),
    })
    if (!sr.ok && sr.status !== 409) {
      const j = await sr.json().catch(() => ({}))
      throw new Error('Deployment created but Service failed: ' + (j?.message || 'HTTP ' + sr.status))
    }
  }

  if (exposeType === 'Ingress') {
    const { host, path, port: iPort, ingressClass: iClass } = ingress
    const clusterSvc = {
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
    }
    const s0 = await kubeFetch(token, envId, `/api/v1/namespaces/${ns}/services`, {
      method: 'POST',
      body: JSON.stringify(clusterSvc),
    })
    if (!s0.ok && s0.status !== 409) {
      const j = await s0.json().catch(() => ({}))
      throw new Error('Deployment created but Service failed: ' + (j?.message || 'HTTP ' + s0.status))
    }

    const ingressMeta = {
      name: appName,
      namespace: ns,
      labels: { app: appName, 'managed-by': 'portainer-run' },
    }
    if (iClass) {
      ingressMeta.annotations = { 'kubernetes.io/ingress.class': iClass }
    }
    const ir = await kubeFetch(
      token,
      envId,
      `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`,
      {
        method: 'POST',
        body: JSON.stringify({
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
                      path: path || '/',
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
        }),
      },
    )
    if (!ir.ok && ir.status !== 409) {
      const j = await ir.json().catch(() => ({}))
      throw new Error('Deployment created but Ingress failed: ' + (j?.message || 'HTTP ' + ir.status))
    }
  }
}

/**
 * @param {object} c
 * @returns {object | null} Kubernetes container spec, or null if no image
 */
export function buildK8sContainer(c) {
  const image = c.image?.trim()
  if (!image) return null
  const name = c.cname?.trim() || (c.isPrimary ? 'app' : 'sidecar')
  const k = { name, image, imagePullPolicy: 'Always' }
  const cpuReq = c.cpuReq?.trim()
  const cpuLim = c.cpuLim?.trim()
  const memReq = c.memReq?.trim()
  const memLim = c.memLim?.trim()
  const res = {}
  if (cpuReq || memReq) res.requests = {}
  if (cpuLim || memLim) res.limits = {}
  if (cpuReq) res.requests.cpu = cpuReq
  if (memReq) res.requests.memory = memReq
  if (cpuLim) res.limits.cpu = cpuLim
  if (memLim) res.limits.memory = memLim
  if (c.gpuEnabled) {
    const n = Math.min(16, Math.max(1, parseInt(String(c.gpuCount), 10) || 1))
    const gk = c.gpuKey || 'nvidia.com/gpu'
    if (!res.limits) res.limits = {}
    if (!res.requests) res.requests = {}
    res.limits[gk] = String(n)
    res.requests[gk] = String(n)
  }
  if (res.requests || res.limits) k.resources = res

  const env = []
  for (const row of c.envRows || []) {
    const key = row.key?.trim()
    if (!key) continue
    if (row.mode === 'secret' && row.secretName && row.secretKey) {
      env.push({ name: key, valueFrom: { secretKeyRef: { name: row.secretName, key: row.secretKey } } })
    } else {
      env.push({ name: key, value: String(row.value ?? '') })
    }
  }
  if (env.length) k.env = env
  const envFrom = (c.envFrom || [])
    .map((e) => e.secret?.trim())
    .filter(Boolean)
    .map((name) => ({ secretRef: { name } }))
  if (envFrom.length) k.envFrom = envFrom
  return k
}

/**
 * @param {object} c
 * @returns {{ name: string, size: string, storageClass?: string, mountPath: string, containerId: string } | null}
 */
export function readVolumeDefForDeploy(c) {
  if (!c.volumeOn) return null
  const name = c.volName?.trim()
  const mountPath = c.volPath?.trim()
  const sizeNum = c.volSizeNum || '1'
  const sizeUnit = c.volSizeUnit || 'Gi'
  if (!name || !mountPath) return null
  return {
    containerId: c.id,
    name,
    size: String(sizeNum) + sizeUnit,
    storageClass: c.volClass?.trim() || undefined,
    mountPath,
  }
}
