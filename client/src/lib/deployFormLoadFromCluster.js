import { kubeFetch } from './api.js'
import { formContainersFromDeploymentSpec } from './deployFormModel.js'

const labelSel = (app) => `app=${app}`

/**
 * Load the same form shape as the deploy page from an existing namespace workload.
 * @param {string} token
 * @param {string} envId
 * @param {string} namespace
 * @param {string} appName deployment (and app label) name
 */
export async function loadDeployFormFromCluster(token, envId, namespace, appName) {
  const depR = await kubeFetch(
    token,
    envId,
    `/apis/apps/v1/namespaces/${namespace}/deployments/${encodeURIComponent(appName)}`,
  )
  if (!depR.ok) {
    const j = await depR.json().catch(() => ({}))
    throw new Error(j?.message || 'HTTP ' + depR.status)
  }
  const d = await depR.json()
  const template = d.spec?.template?.spec
  if (!template) throw new Error('Deployment has no pod template')

  const claimNames = new Set()
  for (const v of template.volumes || []) {
    if (v.persistentVolumeClaim?.claimName) {
      claimNames.add(v.persistentVolumeClaim.claimName)
    }
  }
  const pvcMap = new Map()
  for (const cn of claimNames) {
    const r = await kubeFetch(
      token,
      envId,
      `/api/v1/namespaces/${namespace}/persistentvolumeclaims/${encodeURIComponent(cn)}`,
    )
    if (r.ok) {
      const pvc = await r.json()
      pvcMap.set(cn, pvc)
    }
  }
  const containers = formContainersFromDeploymentSpec(template, pvcMap)
  if (!containers.length) {
    throw new Error('No containers in deployment spec')
  }

  const [svcR, ingR] = await Promise.all([
    kubeFetch(
      token,
      envId,
      `/api/v1/namespaces/${namespace}/services?labelSelector=${encodeURIComponent(labelSel(appName))}`,
    ),
    kubeFetch(
      token,
      envId,
      `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses?labelSelector=${encodeURIComponent(labelSel(appName))}`,
    ),
  ])
  const svcs = svcR.ok ? (await svcR.json()).items || [] : []
  const ings = ingR.ok ? (await ingR.json()).items || [] : []

  const primaryService =
    svcs.find((s) => s.metadata?.name === appName) || svcs[0] || null

  let exposeType = 'none'
  let svcPorts = ['80']
  let ingHost = ''
  let ingPath = '/'
  let ingPort = 80
  let ingClass = ''

  if (ings.length) {
    exposeType = 'Ingress'
    const ing = ings[0]
    const cls = ing.spec?.ingressClassName || ing.metadata?.annotations?.['kubernetes.io/ingress.class'] || ''
    ingClass = cls || ''
    const rule0 = (ing.spec?.rules || [])[0]
    if (rule0?.host) ingHost = rule0.host
    const path0 = (rule0?.http?.paths || [])[0]
    if (path0?.path) ingPath = path0.path
    const num = path0?.backend?.service?.port?.number
    if (num != null) ingPort = num
  } else if (primaryService) {
    const t = primaryService.spec?.type || 'ClusterIP'
    if (t === 'NodePort' || t === 'LoadBalancer') {
      exposeType = t
      const ports = (primaryService.spec?.ports || [])
        .map((p) => p.port)
        .filter((n) => n > 0)
      if (ports.length) svcPorts = ports.map((p) => String(p))
    } else {
      exposeType = 'none'
    }
  }

  return {
    resourceVersion: d.metadata?.resourceVersion,
    instances: d.spec?.replicas ?? 1,
    containers,
    exposeType,
    svcPorts,
    ingHost,
    ingPath,
    ingPort,
    ingClass,
  }
}
