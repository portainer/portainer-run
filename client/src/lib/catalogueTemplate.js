/**
 * Port template catalogue: Knative-style manifests in repo-root `templates.json` and deploy form state.
 * Parsing logic ported from `old-implementation/portainer-run.html` (parseKnativeManifest).
 */

const GPU_KEYS = [
  'nvidia.com/gpu',
  'amd.com/gpu',
  'gpu.intel.com/i915',
  'habana.ai/gaudi',
]

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'c-' + Date.now() + '-' + Math.random().toString(16).slice(2)
}

export const CATALOGUE_CATEGORY_LABELS = {
  all: 'All',
  cms: 'CMS',
  database: 'Database',
  web: 'Web',
  monitoring: 'Monitoring',
  messaging: 'Messaging',
  devtools: 'Dev Tools',
}

export const CATALOGUE_CATEGORY_COLORS = {
  cms: 'var(--accent)',
  database: '#40EFDE',
  web: '#a78bfa',
  monitoring: '#fb923c',
  messaging: '#34d399',
  devtools: '#94a3b8',
}

/**
 * @param {object} manifest — Knative Service-like JSON
 * @param {{ baseDomain?: string }} [opts]
 * @returns {{
 *   name: string,
 *   namespace: string,
 *   instances: number,
 *   exposure: { type: string, host?: string, port?: number, ports?: number[] },
 *   containers: Array<{
 *     name: string, image: string, env: Array<{ name: string, value: string }>,
 *     cpuReq: string, cpuLim: string, memReq: string, memLim: string,
 *     storage: { name: string, size: string, mountPath: string } | null,
 *     gpuKey: string | null, gpuCount: number
 *   }>,
 *   warnings: string[]
 * }}
 */
export function parseKnativeManifest(manifest, opts = {}) {
  const baseDomain = (opts.baseDomain || '').trim()
  const spec = manifest?.spec?.template?.spec || {}
  const containers = spec.containers || []
  const volumes = spec.volumes || []
  const annotations = manifest?.metadata?.annotations || {}
  const instances = parseInt(annotations['autoscaling.knative.dev/minScale'] || '1', 10) || 1

  const mappedContainers = containers.map((ct, i) => {
    let storage = null
    const vm = (ct.volumeMounts || [])[0]
    if (vm) {
      const vol = volumes.find((v) => v.name === vm.name)
      if (vol) {
        storage = {
          name: vm.name,
          size: '1Gi',
          mountPath: vm.mountPath,
        }
      }
    }

    let gpuKey = null
    let gpuCount = 0
    const limits = ct.resources?.limits || {}
    for (const gk of GPU_KEYS) {
      if (limits[gk]) {
        gpuKey = gk
        gpuCount = parseInt(limits[gk], 10) || 1
        break
      }
    }

    return {
      name: ct.name || 'container-' + i,
      image: ct.image || '',
      env: (ct.env || []).map((e) => ({ name: e.name, value: e.value || '' })),
      cpuReq: ct.resources?.requests?.cpu || '100m',
      cpuLim: ct.resources?.limits?.cpu || '500m',
      memReq: ct.resources?.requests?.memory || '128Mi',
      memLim: ct.resources?.limits?.memory || '512Mi',
      storage,
      gpuKey,
      gpuCount,
    }
  })

  const port = containers[0]?.ports?.[0]?.containerPort || 80

  let exposure
  if (baseDomain) {
    const metaName = manifest?.metadata?.name || 'app'
    exposure = {
      type: 'Ingress',
      host: metaName + '.' + baseDomain,
      port,
    }
  } else {
    exposure = { type: 'NodePort', ports: [port] }
  }

  return {
    name: manifest?.metadata?.name || 'app',
    namespace: 'default',
    instances,
    exposure,
    containers: mappedContainers,
    warnings: [],
  }
}

/**
 * Shape matches DeployPage container state (from createContainer).
 * @param {ReturnType<typeof parseKnativeManifest>} cfg
 */
export function buildContainersStateFromConfig(cfg) {
  const appName = cfg.name || 'app'
  return (cfg.containers || []).map((ct, i) => {
    const id = newId()
    const envRows = (ct.env || []).map((e) => ({
      id: newId(),
      mode: 'plain',
      key: e.name,
      value: e.value || '',
      secretName: '',
      secretKey: '',
    }))

    const hasStorage = Boolean(ct.storage)
    const volName = hasStorage
      ? (appName + '-' + (ct.storage.name || (ct.name || 'c') + '-data')).slice(0, 60).replace(/-+$/, '')
      : i === 0
        ? 'app-data'
        : 'sidecar-data'
    const sm = (ct.storage?.size || '1Gi').match(/^([\d.]+)(Mi|Gi|Ti)$/)

    return {
      id,
      isPrimary: i === 0,
      cname: ct.name || (i === 0 ? 'app' : 'sidecar-' + i),
      image: ct.image || '',
      cpuReq: ct.cpuReq || '',
      cpuLim: ct.cpuLim || '',
      memReq: ct.memReq || '',
      memLim: ct.memLim || '',
      gpuEnabled: Boolean(ct.gpuKey && ct.gpuCount > 0),
      gpuCount: Math.max(1, ct.gpuCount || 1),
      gpuKey: ct.gpuKey || 'nvidia.com/gpu',
      gpuLabel: '',
      gpuWarn: undefined,
      volumeOn: hasStorage,
      volName: hasStorage ? volName : i === 0 ? 'app-data' : 'sidecar-data',
      volClass: '',
      volSizeNum: sm ? sm[1] : '1',
      volSizeUnit: sm ? sm[2] : 'Gi',
      volPath: hasStorage ? ct.storage.mountPath || '/data' : '/data',
      envRows,
      envFrom: [],
    }
  })
}

/**
 * Values to apply to DeployPage state (service, exposure, containers).
 * @param {ReturnType<typeof parseKnativeManifest>} cfg
 */
export function mapDeployConfigToFormValues(cfg) {
  const exp = cfg.exposure || { type: 'none' }
  let exposeType = 'none'
  let svcPorts = ['80']
  let ingHost = ''
  const ingPath = '/'
  let ingPort = 80
  const ingClass = ''

  if (exp.type === 'Ingress') {
    exposeType = 'Ingress'
    ingHost = exp.host || ''
    ingPort = exp.port != null ? Math.max(1, parseInt(String(exp.port), 10) || 80) : 80
  } else if (exp.type === 'NodePort' || exp.type === 'LoadBalancer') {
    exposeType = exp.type
    const ps = exp.ports?.length ? exp.ports : [exp.port || 80]
    svcPorts = ps.map((p) => String(p))
  } else {
    exposeType = 'none'
  }

  const containers = buildContainersStateFromConfig(cfg)
  return {
    serviceName: cfg.name || '',
    instances: Math.max(0, Math.min(100, parseInt(String(cfg.instances), 10) || 1)),
    exposeType,
    svcPorts,
    ingHost,
    ingPath,
    ingPort,
    ingClass,
    containers: containers.length ? containers : null,
  }
}
