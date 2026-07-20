/** Must stay in sync with `detectClusterGpuType` in deployK8s.js */
export const GPU_RESOURCE_KEYS = [
  'nvidia.com/gpu',
  'amd.com/gpu',
  'gpu.intel.com/i915',
  'habana.ai/gaudi',
]

export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID)
    return crypto.randomUUID()
  return 'c-' + Date.now() + '-' + Math.random().toString(16).slice(2)
}

export function createContainer(isPrimary) {
  return {
    id: newId(),
    isPrimary,
    cname: isPrimary ? 'app' : '',
    image: '',
    cpuReq: '',
    cpuLim: '',
    memReq: '',
    memLim: '',
    gpuEnabled: false,
    gpuCount: 1,
    gpuKey: 'nvidia.com/gpu',
    gpuLabel: '',
    gpuWarn: undefined,
    volumeOn: false,
    volName: isPrimary ? 'app-data' : 'sidecar-data',
    volClass: '',
    volSizeNum: '1',
    volSizeUnit: 'Gi',
    volPath: '/data',
    envRows: [],
    envFrom: [],
  }
}

export function withDefaultCnames(containers) {
  return containers.map((c, i) => {
    if (c.cname?.trim()) return { ...c, cname: c.cname.trim() }
    return { ...c, cname: i === 0 ? 'app' : `sidecar-${i}` }
  })
}

/**
 * Parse Kubernetes quantity like "1Gi" / "512Mi"
 * @returns {{ num: string, unit: string }}
 */
export function parseQuantityString(q) {
  const s = String(q || '').trim()
  const m = s.match(/^(\d+(?:\.\d+)?)(Mi|Gi|Ti)$/i)
  if (m)
    return {
      num: m[1],
      unit: m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase(),
    }
  if (/^\d+$/i.test(s)) return { num: s, unit: 'Gi' }
  return { num: '1', unit: 'Gi' }
}

/**
 * Build a deploy form container row from a K8s container and optional per-container volume.
 * @param {object} c
 * @param {object} opts
 * @param {boolean} opts.isPrimary
 * @param {string} opts.id
 * @param {object} [opts.volume] volume fields merged when PVC mount exists
 */
export function k8sContainerToFormRow(c, { isPrimary, id, volume }) {
  const cpuReq = c.resources?.requests?.cpu || ''
  const cpuLim = c.resources?.limits?.cpu || ''
  const memReq = c.resources?.requests?.memory || ''
  const memLim = c.resources?.limits?.memory || ''
  let gpuEnabled = false
  let gpuCount = 1
  let gpuKey = 'nvidia.com/gpu'
  for (const key of GPU_RESOURCE_KEYS) {
    const lim = c.resources?.limits?.[key]
    if (lim != null && String(lim) !== '0') {
      gpuEnabled = true
      gpuKey = key
      gpuCount = Math.max(1, Math.min(16, parseInt(String(lim), 10) || 1))
      break
    }
  }

  const envRows = []
  for (const e of c.env || []) {
    if (e.valueFrom?.secretKeyRef) {
      const sk = e.valueFrom.secretKeyRef
      envRows.push({
        id: newId(),
        mode: 'secret',
        key: e.name || '',
        value: '',
        secretName: sk.name || '',
        secretKey: sk.key || '',
      })
    } else {
      envRows.push({
        id: newId(),
        mode: 'plain',
        key: e.name || '',
        value: e.value != null ? e.value : '',
        secretName: '',
        secretKey: '',
      })
    }
  }

  const envFrom = []
  for (const ef of c.envFrom || []) {
    if (ef.secretRef?.name) {
      envFrom.push({ id: newId(), secret: ef.secretRef.name })
    }
  }

  const base = {
    id,
    isPrimary,
    cname: c.name || (isPrimary ? 'app' : 'sidecar'),
    image: c.image || '',
    cpuReq,
    cpuLim,
    memReq,
    memLim,
    gpuEnabled,
    gpuCount,
    gpuKey,
    gpuLabel: '',
    gpuWarn: undefined,
    volumeOn: false,
    volName: isPrimary ? 'app-data' : 'sidecar-data',
    volClass: '',
    volSizeNum: '1',
    volSizeUnit: 'Gi',
    volPath: '/data',
    envRows,
    envFrom,
  }
  if (volume) {
    return {
      ...base,
      ...volume,
    }
  }
  return base
}

/**
 * @param {object} templatePodSpec deployment.spec.template.spec
 * @param {Map<string, object>} pvcByClaimName parsed PVC json by claim name
 */
export function formContainersFromDeploymentSpec(
  templatePodSpec,
  pvcByClaimName,
) {
  const vols = templatePodSpec.volumes || []
  const cts = templatePodSpec.containers || []
  return cts.map((c, i) => {
    const isPrimary = i === 0
    let volPatch = null
    for (const vm of c.volumeMounts || []) {
      const v = vols.find((x) => x.name === vm.name)
      if (v?.persistentVolumeClaim?.claimName) {
        const claimName = v.persistentVolumeClaim.claimName
        const pvc = pvcByClaimName.get(claimName)
        const storage = pvc?.spec?.resources?.requests?.storage || '1Gi'
        const { num, unit } = parseQuantityString(storage)
        volPatch = {
          volumeOn: true,
          volName: claimName,
          volClass: pvc?.spec?.storageClassName || '',
          volSizeNum: num,
          volSizeUnit: unit,
          volPath: vm.mountPath || '/data',
        }
        break
      }
    }
    return k8sContainerToFormRow(c, {
      isPrimary,
      id: newId(),
      volume: volPatch || undefined,
    })
  })
}
