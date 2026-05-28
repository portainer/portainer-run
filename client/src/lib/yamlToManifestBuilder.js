import jsyaml from 'js-yaml'
import { newId } from './deployFormModel.js'

/**
 * Parse a multi-document YAML string into ManifestBuilder form state.
 * Returns { state, warnings } where warnings lists unsupported fields.
 *
 * @param {string} yamlContent
 * @returns {{ state: object, warnings: string[] }}
 */
export function yamlToManifestBuilder(yamlContent) {
  const warnings = []
  const docs = jsyaml.loadAll(yamlContent).filter(Boolean)

  // Find the primary workload
  const workload = docs.find((d) =>
    ['Deployment', 'StatefulSet', 'DaemonSet'].includes(d?.kind)
  )
  const services = docs.filter((d) => d?.kind === 'Service')
  const ingresses = docs.filter((d) => d?.kind === 'Ingress')
  const pvcs = docs.filter((d) => d?.kind === 'PersistentVolumeClaim')
  const hpa = docs.find((d) => d?.kind === 'HorizontalPodAutoscaler')

  if (!workload) {
    return {
      state: null,
      warnings: ['No Deployment, StatefulSet, or DaemonSet found in the manifest.'],
    }
  }

  const spec = workload.spec || {}
  const template = spec.template || {}
  const podSpec = template.spec || {}
  const containers = podSpec.containers || []
  const ann = workload.metadata?.annotations || {}

  // Warn about unsupported fields
  if (containers.length > 1) {
    warnings.push(`${containers.length} containers found — only the first container is editable in the Manifest Builder. Additional containers are preserved in Git.`)
  }
  if (podSpec.initContainers?.length) warnings.push('Init containers are not supported in the form — they are preserved in Git.')
  if (podSpec.securityContext) warnings.push('Pod security context is not editable in the form — preserved in Git.')
  const c = containers[0] || {}
  if (c.securityContext) warnings.push('Container security context is not editable in the form — preserved in Git.')
  if (c.livenessProbe || c.readinessProbe || c.startupProbe) warnings.push('Health probes are not editable in the form — preserved in Git.')
  if (c.lifecycle) warnings.push('Lifecycle hooks are not editable in the form — preserved in Git.')

  // Deployment type
  const deploymentType = workload.kind === 'StatefulSet' ? 'StatefulSet'
    : workload.kind === 'DaemonSet' ? 'DaemonSet'
    : 'Deployment'

  // Instances
  const instances = spec.replicas ?? 1

  // Image
  const image = c.image || ''

  // Pull secret
  const pullSecret = podSpec.imagePullSecrets?.[0]?.name || ''

  // Pull policy
  const pullPolicy = c.imagePullPolicy || 'Always'

  // Env vars
  const envVars = (c.env || []).map((e) => {
    if (e.valueFrom?.secretKeyRef) {
      return {
        id: newId(),
        mode: 'secret',
        key: e.name,
        value: '',
        secretName: e.valueFrom.secretKeyRef.name,
        secretKey: e.valueFrom.secretKeyRef.key,
      }
    }
    return { id: newId(), mode: 'plain', key: e.name, value: e.value || '', secretName: '', secretKey: '' }
  })

  // ConfigMap and Secret refs from envFrom
  const configMapRefs = []
  const secretRefs = []
  for (const ef of (c.envFrom || [])) {
    if (ef.configMapRef?.name) {
      configMapRefs.push({ id: newId(), name: ef.configMapRef.name, mode: 'env', mountPath: '' })
    }
    if (ef.secretRef?.name) {
      secretRefs.push({ id: newId(), name: ef.secretRef.name, mode: 'env', mountPath: '' })
    }
  }

  // Volume mounts → check if they reference a CM or Secret volume
  for (const vm of (c.volumeMounts || [])) {
    const vol = (podSpec.volumes || []).find((v) => v.name === vm.name)
    if (!vol) continue
    if (vol.configMap?.name) {
      configMapRefs.push({ id: newId(), name: vol.configMap.name, mode: 'mount', mountPath: vm.mountPath })
    } else if (vol.secret?.secretName) {
      secretRefs.push({ id: newId(), name: vol.secret.secretName, mode: 'mount', mountPath: vm.mountPath })
    }
    // PVC mounts handled via pvcs array below
  }

  // Resources
  const res = c.resources || {}
  const cpuReq = res.requests?.cpu || ''
  const memReq = res.requests?.memory || ''
  const cpuLim = res.limits?.cpu || ''
  const memLim = res.limits?.memory || ''

  // GPU
  const GPU_KEYS = ['nvidia.com/gpu', 'amd.com/gpu', 'gpu.intel.com/i915', 'habana.ai/gaudi']
  let gpuEnabled = false
  let gpuKey = 'nvidia.com/gpu'
  let gpuCount = 1
  for (const key of GPU_KEYS) {
    if (res.limits?.[key]) {
      gpuEnabled = true
      gpuKey = key
      gpuCount = parseInt(res.limits[key], 10) || 1
      break
    }
  }

  // Volumes (PVCs)
  const volumes = pvcs.map((pvc) => {
    const mount = (c.volumeMounts || []).find((vm) => {
      const vol = (podSpec.volumes || []).find((v) => v.persistentVolumeClaim?.claimName === pvc.metadata?.name)
      return vol && vol.name === vm.name
    })
    return {
      id: newId(),
      mountPath: mount?.mountPath || '/data',
      size: pvc.spec?.resources?.requests?.storage?.replace(/[A-Za-z]+$/, '') || '1',
      sizeUnit: pvc.spec?.resources?.requests?.storage?.replace(/[0-9.]+/, '') || 'Gi',
      storageClass: pvc.spec?.storageClassName || '',
      accessPolicy: pvc.spec?.accessModes?.includes('ReadWriteMany') ? 'shared' : 'isolated',
    }
  })

  // For StatefulSet volumeClaimTemplates
  if (deploymentType === 'StatefulSet' && spec.volumeClaimTemplates?.length) {
    for (const vct of spec.volumeClaimTemplates) {
      const mount = (c.volumeMounts || []).find((vm) => vm.name === vct.metadata?.name)
      volumes.push({
        id: newId(),
        mountPath: mount?.mountPath || '/data',
        size: vct.spec?.resources?.requests?.storage?.replace(/[A-Za-z]+$/, '') || '1',
        sizeUnit: vct.spec?.resources?.requests?.storage?.replace(/[0-9.]+/, '') || 'Gi',
        storageClass: vct.spec?.storageClassName || '',
        accessPolicy: vct.spec?.accessModes?.includes('ReadWriteMany') ? 'shared' : 'isolated',
      })
    }
  }

  // Auto-scaling from HPA
  let autoScalingEnabled = false
  let minInstances = 1
  let maxInstances = 3
  let targetCpu = 70
  if (hpa) {
    autoScalingEnabled = true
    minInstances = hpa.spec?.minReplicas ?? 1
    maxInstances = hpa.spec?.maxReplicas ?? 3
    const cpuMetric = (hpa.spec?.metrics || []).find((m) => m.resource?.name === 'cpu')
    targetCpu = cpuMetric?.resource?.target?.averageUtilization ?? 70
  }

  // Placement rules from nodeSelector and affinity
  const placementRules = []
  for (const [k, v] of Object.entries(podSpec.nodeSelector || {})) {
    placementRules.push({ id: newId(), key: k, value: v, policy: 'Mandatory' })
  }
  const preferred = podSpec.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution || []
  for (const term of preferred) {
    const expr = term.preference?.matchExpressions?.[0]
    if (expr) {
      placementRules.push({ id: newId(), key: expr.key, value: expr.values?.[0] || '', policy: 'Preferred' })
    }
  }

  // Services
  const svcList = services.map((svc) => {
    const port = svc.spec?.ports?.[0] || {}
    const ing = ingresses.find((i) =>
      i.spec?.rules?.[0]?.http?.paths?.[0]?.backend?.service?.name === svc.metadata?.name
    )
    return {
      id: newId(),
      type: svc.spec?.type || 'ClusterIP',
      containerPort: String(port.targetPort || port.port || ''),
      servicePort: String(port.port || ''),
      protocol: port.protocol || 'TCP',
      ingressEnabled: Boolean(ing),
      ingressHost: ing?.spec?.rules?.[0]?.host || '',
      ingressPath: ing?.spec?.rules?.[0]?.http?.paths?.[0]?.path || '/',
      ingressClass: ing?.spec?.ingressClassName || svc.metadata?.annotations?.['kubernetes.io/ingress.class'] || '',
    }
  })

  // Annotations (user-defined only, strip portainer-run/* system annotations)
  const userAnnotations = Object.entries(ann)
    .filter(([k]) => !k.startsWith('portainer-run/') && !k.startsWith('kubectl.kubernetes.io/'))
    .map(([key, value]) => ({ id: newId(), key, value: String(value) }))

  // Note
  const note = ann['portainer-run/note'] || ''

  return {
    warnings,
    state: {
      appName: workload.metadata?.name || '',
      deploymentType,
      instances,
      note,
      annotations: userAnnotations,
      image,
      pullSecret,
      pullPolicy,
      envVars,
      configMapRefs,
      secretRefs,
      volumes,
      cpuReq,
      cpuLim,
      memReq,
      memLim,
      gpuEnabled,
      gpuKey,
      gpuCount,
      autoScalingEnabled,
      minInstances,
      maxInstances,
      targetCpu,
      placementRules,
      services: svcList,
    },
  }
}
