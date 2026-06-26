import { apiFetch, kubeFetch } from './api.js'
import { inflightDedupe } from './inflightDedupe.js'
import { GPU_RESOURCE_KEYS } from './deployFormModel.js'

export { GPU_RESOURCE_KEYS } from './deployFormModel.js'

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

/**
 * @param {string} token
 * @param {string} envId
 */
export async function fetchStorageClasses(token, envId) {
  return inflightDedupe(`k8s:storage-classes:${envId}`, async () => {
    const r = await kubeFetch(token, envId, '/apis/storage.k8s.io/v1/storageclasses')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return (await r.json()).items || []
  })
}

/**
 * @param {string} token
 * @param {string} envId
 * @param {string} ns
 */
export async function fetchSecretsInNamespace(token, envId, ns) {
  if (!ns) return []
  return inflightDedupe(`k8s:secrets:${envId}:${ns}`, async () => {
    const r = await kubeFetch(token, envId, `/api/v1/namespaces/${ns}/secrets`)
    if (!r.ok) return []
    const items = (await r.json()).items || []
    return items.filter((s) => !isSystemSecret(s))
  })
}

const MANAGED_BY_LABEL = 'managed-by=portainer-run'

/**
 * For each secret name, lists unique portainer-run deployment names that reference it (env + envFrom).
 * @param {string} token
 * @param {string} envId
 * @param {string} ns
 * @returns {Promise<Record<string, string[]>>}
 */
export async function fetchSecretUsageFromManagedDeployments(token, envId, ns) {
  if (!ns) return {}
  return inflightDedupe(`k8s:secret-usage:${envId}:${ns}`, async () => {
  const r = await kubeFetch(
    token,
    envId,
    `/apis/apps/v1/namespaces/${ns}/deployments?labelSelector=${encodeURIComponent(MANAGED_BY_LABEL)}`,
  )
  if (!r.ok) return {}
  const deps = (await r.json()).items || []
  /** @type {Record<string, string[]>} */
  const usage = {}
  for (const dep of deps) {
    const dname = dep.metadata?.name
    if (!dname) continue
    const containers = dep.spec?.template?.spec?.containers || []
    for (const ct of containers) {
      for (const env of ct.env || []) {
        if (env.valueFrom?.secretKeyRef?.name) {
          const sn = env.valueFrom.secretKeyRef.name
          if (!usage[sn]) usage[sn] = []
          if (!usage[sn].includes(dname)) usage[sn].push(dname)
        }
      }
      for (const envFrom of ct.envFrom || []) {
        if (envFrom.secretRef?.name) {
          const sn = envFrom.secretRef.name
          if (!usage[sn]) usage[sn] = []
          if (!usage[sn].includes(dname)) usage[sn].push(dname)
        }
      }
    }
  }
  return usage
  })
}

/**
 * @param {string} value
 * @returns {string} base64 (Kubernetes `data` field)
 */
export function secretValueToK8sDataB64(value) {
  return btoa(unescape(encodeURIComponent(value)))
}

/**
 * @param {string} token
 * @param {string} envId
 * @param {string} ns
 * @param {string} name
 * @param {Record<string, string>} dataPlain key → raw value (not base64)
 */
export async function createOpaquePortainerSecret(token, envId, ns, name, dataPlain) {
  const data = {}
  for (const [k, v] of Object.entries(dataPlain)) {
    data[k] = secretValueToK8sDataB64(v)
  }
  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name,
      namespace: ns,
      labels: { 'managed-by': 'portainer-run' },
    },
    data,
  }
  const r = await kubeFetch(token, envId, `/api/v1/namespaces/${ns}/secrets`, {
    method: 'POST',
    body: JSON.stringify(manifest),
  })
  if (r.status === 409) {
    const err = new Error(`A secret named "${name}" already exists.`)
    throw err
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw new Error(j?.message || 'HTTP ' + r.status)
  }
}

/**
 * @param {string} token
 * @param {string} envId
 * @param {string} ns
 * @param {string} name
 * @returns {Promise<Response>}
 */
export function deleteNamespacedSecret(token, envId, ns, name) {
  return kubeFetch(token, envId, `/api/v1/namespaces/${ns}/secrets/${name}`, { method: 'DELETE' })
}

/**
 * @param {string} token
 * @param {string} envId
 * @returns {Promise<{ key: string, label: string, warn?: 'amber' | 'green' }>}
 */
export async function detectClusterGpuType(token, envId) {
  if (!envId) return { key: 'nvidia.com/gpu', label: 'Select an environment first' }
  return inflightDedupe(`k8s:gpu-type:${envId}`, async () => {
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
  })
}

/** Alias for older imports — same as `detectClusterGpuType` */
export { detectClusterGpuType as detectClusterGpu }

/**
 * @param {string} token
 * @param {object} p2
 * @param {{ name: string, size: string, storageClass?: string, mountPath: string, containerId: string }[]} p2.volumeDefs
 */
export async function ensureVolumePvcs(token, envId, ns, appName, volumeDefs) {
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
}

/**
 * Create Service + optional Ingress to match the deploy form (idempotent: 409 OK on create).
 */
export async function createExposureForApp(
  token,
  { envId, ns, appName, exposeType, servicePorts, ingress },
) {
  if (exposeType === 'none' || !exposeType) return

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
    return
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
 * @param {string} token
 * @param {object} p0
 * @param {string[]} p0.containerRowIds — same length as `containerSpecs`; `volumeDefs[].containerId` must match
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

  await ensureVolumePvcs(token, envId, ns, appName, volumeDefs)

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

  await createExposureForApp(token, { envId, ns, appName, exposeType, servicePorts, ingress })
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

async function deleteK8sIfExists(token, envId, path) {
  const r = await kubeFetch(token, envId, path, { method: 'DELETE' })
  return r.ok || r.status === 404
}

/**
 * Remove the portainer-run Service and Ingress (same name as the app) so exposure can be recreated.
 */
export async function replacePortainerRunExposure(token, envId, ns, appName) {
  await deleteK8sIfExists(
    token,
    envId,
    `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${encodeURIComponent(appName)}`,
  )
  await deleteK8sIfExists(
    token,
    envId,
    `/api/v1/namespaces/${ns}/services/${encodeURIComponent(appName)}`,
  )
}

/**
 * Build container specs, ensure PVCs, update the Deployment, then re-apply Service/Ingress to match the deploy form.
 * Expects the same pre-built `containerSpecs` / `containerRowIds` as `executeDeploy`, but applies via PUT.
 */
export async function applyDeploymentFormUpdate(
  token,
  {
    envId,
    ns,
    appName,
    instances,
    containerSpecs,
    volumeDefs,
    containerRowIds,
    exposeType,
    servicePorts,
    ingress,
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

  await ensureVolumePvcs(token, envId, ns, appName, volumeDefs)

  const getR = await kubeFetch(
    token,
    envId,
    `/apis/apps/v1/namespaces/${ns}/deployments/${encodeURIComponent(appName)}`,
  )
  if (!getR.ok) {
    const j = await getR.json().catch(() => ({}))
    throw new Error(j?.message || 'HTTP ' + getR.status)
  }
  const current = await getR.json()
  const tplMeta = current.spec?.template?.metadata || {}
  const labels = { ...(tplMeta.labels || {}), app: appName, 'managed-by': 'portainer-run' }
  const mergedTplMeta = { ...tplMeta, labels }
  const oldPod = current.spec?.template?.spec || {}
  const nextPod = { ...oldPod, containers: containerSpecs }
  if (podVolumes.length) {
    nextPod.volumes = podVolumes
  } else {
    delete nextPod.volumes
  }
  const next = { ...current }
  if (next.status) delete next.status
  next.spec = {
    ...current.spec,
    replicas: Math.max(0, Math.min(100, parseInt(String(instances), 10) || 0)),
    template: {
      metadata: mergedTplMeta,
      spec: nextPod,
    },
  }
  if (next.status) delete next.status
  const putR = await kubeFetch(
    token,
    envId,
    `/apis/apps/v1/namespaces/${ns}/deployments/${encodeURIComponent(appName)}`,
    { method: 'PUT', body: JSON.stringify(next) },
  )
  if (!putR.ok) {
    const j = await putR.json().catch(() => ({}))
    throw new Error(j?.message || 'HTTP ' + putR.status)
  }

  await replacePortainerRunExposure(token, envId, ns, appName)
  const portsNum = (servicePorts || [])
    .map((p) => (typeof p === 'number' ? p : parseInt(String(p), 10)))
    .filter((n) => n > 0)
  await createExposureForApp(token, {
    envId,
    ns,
    appName,
    exposeType,
    servicePorts: portsNum,
    ingress,
  })
}

/**
 * Fetch ResourceQuotas for a namespace and return which resource fields are required.
 * Returns { requiresLimits: bool, requiresRequests: bool } based on quota hard limits.
 */
export async function fetchNamespaceQuota(token, envId, ns) {
  try {
    const r = await kubeFetch(token, envId, `/api/v1/namespaces/${ns}/resourcequotas`)
    if (!r.ok) return { requiresLimits: false, requiresRequests: false }
    const data = await r.json()
    const quotas = data.items || []
    let requiresLimits = false
    let requiresRequests = false
    for (const q of quotas) {
      const hard = q.spec?.hard || {}
      if (hard['limits.cpu'] || hard['limits.memory']) requiresLimits = true
      if (hard['requests.cpu'] || hard['requests.memory']) requiresRequests = true
    }
    return { requiresLimits, requiresRequests }
  } catch {
    return { requiresLimits: false, requiresRequests: false }
  }
}

/**
 * Fetch ConfigMaps in a namespace.
 */
const SYSTEM_CONFIGMAP_PATTERNS = [
  /^kube-/,
  /^system:/,
  /^istio/,
  /^coredns/,
]
const SYSTEM_CONFIGMAP_NAMES = new Set([
  'kube-root-ca.crt',
])

export async function fetchConfigMapsInNamespace(token, envId, ns) {
  if (!ns) return []
  return inflightDedupe(`k8s:configmaps:${envId}:${ns}`, async () => {
    const r = await kubeFetch(token, envId, `/api/v1/namespaces/${ns}/configmaps`)
    if (!r.ok) return []
    const items = (await r.json()).items || []
    return items
      .filter((cm) => {
        const name = cm.metadata.name
        if (SYSTEM_CONFIGMAP_NAMES.has(name)) return false
        if (SYSTEM_CONFIGMAP_PATTERNS.some((p) => p.test(name))) return false
        return true
      })
      .map((cm) => ({
        name: cm.metadata.name,
        keys: Object.keys(cm.data || {}),
      }))
  })
}

/**
 * Fetch imagePullSecrets (kubernetes.io/dockerconfigjson) in a namespace.
 */
const SYSTEM_SECRET_TYPES = new Set([
  'kubernetes.io/service-account-token',
  'bootstrap.kubernetes.io/token',
  'kubernetes.io/tls',
])
const SYSTEM_SECRET_PATTERNS = [
  /^default-token-/,
  /^kube-/,
]

function isSystemSecret(s) {
  if (SYSTEM_SECRET_TYPES.has(s.type)) return true
  const name = s.metadata.name
  if (SYSTEM_SECRET_PATTERNS.some((p) => p.test(name))) return true
  return false
}

export async function fetchImagePullSecrets(token, envId, ns) {
  if (!ns) return []
  return inflightDedupe(`k8s:pullsecrets:${envId}:${ns}`, async () => {
    const r = await kubeFetch(token, envId, `/api/v1/namespaces/${ns}/secrets`)
    if (!r.ok) return []
    const items = (await r.json()).items || []
    return items
      .filter((s) => !isSystemSecret(s) && (s.type === 'kubernetes.io/dockerconfigjson' || s.type === 'kubernetes.io/dockercfg'))
      .map((s) => s.metadata.name)
  })
}
