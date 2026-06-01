import yaml from 'js-yaml'
import { normalizeQuantity } from './manifestSerialize.js'

/**
 * Accepts ManifestBuilder form state, validates quantities,
 * produces multi-document YAML string with GitOps annotations.
 *
 * @param {object} state  ManifestBuilder form state
 * @param {object} gitopsAnnotations  { gitTargetId, gitBranch, gitPath }
 * @returns {string}  multi-document YAML
 */
export function serializeManifestBuilder(state, gitopsAnnotations) {
  // Normalize and validate quantities
  const cpuReq = normalizeQuantity(state.cpuReq, 'cpu')
  const cpuLim = normalizeQuantity(state.cpuLim, 'cpu')
  const memReq = normalizeQuantity(state.memReq, 'memory')
  const memLim = normalizeQuantity(state.memLim, 'memory')

  // Patch normalized values back
  const normalized = {
    ...state,
    cpuReq: cpuReq || '',
    cpuLim: cpuLim || '',
    memReq: memReq || '',
    memLim: memLim || '',
  }

  // Import the same converter logic (duplicated here to avoid browser/server boundary issues)
  const manifests = buildManifests(normalized, gitopsAnnotations)

  return manifests
    .filter(Boolean)
    .map((m) => yaml.dump(m, { lineWidth: 120, noRefs: true }))
    .join('---\n')
}

function buildManifests(state, gitopsAnnotations) {
  const {
    appName, deploymentType, instances, image, pullSecret, pullPolicy,
    envVars, configMapRefs, secretRefs, volumes, cpuReq, cpuLim, memReq,
    memLim, gpuEnabled, gpuCount, gpuKey, autoScalingEnabled, minInstances,
    maxInstances, targetCpu, placementRules, services, annotations, note,
    namespace,
  } = state

  const labels = { app: appName, 'managed-by': 'portainer-run' }
  const ann = {
    'portainer-run/git-target-id': gitopsAnnotations.gitTargetId,
    'portainer-run/git-branch': gitopsAnnotations.gitBranch,
    'portainer-run/git-path': gitopsAnnotations.gitPath,
    'portainer-run/deploy-type': 'manifest-builder',
  }
  if (note) ann['portainer-run/note'] = note
  for (const a of (annotations || [])) {
    if (a.key?.trim()) ann[a.key.trim()] = a.value || ''
  }

  const containerEnv = []
  for (const v of (envVars || [])) {
    if (!v.key?.trim()) continue
    if (v.mode === 'secret') {
      containerEnv.push({ name: v.key, valueFrom: { secretKeyRef: { name: v.secretName, key: v.secretKey } } })
    } else {
      containerEnv.push({ name: v.key, value: v.value || '' })
    }
  }

  const volumeMounts = []
  const podVolumes = []

  for (const cm of (configMapRefs || [])) {
    if (!cm.name) continue
    if (cm.mode === 'mount' && cm.mountPath) {
      const volName = `cm-${cm.name}`
      volumeMounts.push({ name: volName, mountPath: cm.mountPath })
      podVolumes.push({ name: volName, configMap: { name: cm.name } })
    }
  }

  for (const sr of (secretRefs || [])) {
    if (!sr.name) continue
    if (sr.mode === 'mount' && sr.mountPath) {
      const volName = `sec-${sr.name}`
      volumeMounts.push({ name: volName, mountPath: sr.mountPath })
      podVolumes.push({ name: volName, secret: { secretName: sr.name } })
    }
  }

  for (let i = 0; i < (volumes || []).length; i++) {
    const v = volumes[i]
    if (!v.mountPath) continue
    const volName = `${appName}-${i}`
    volumeMounts.push({ name: volName, mountPath: v.mountPath })
    if (deploymentType !== 'StatefulSet') {
      podVolumes.push({ name: volName, persistentVolumeClaim: { claimName: volName } })
    }
  }

  const envFrom = []
  for (const cm of (configMapRefs || [])) {
    if (cm.name && cm.mode === 'env') envFrom.push({ configMapRef: { name: cm.name } })
  }
  for (const sr of (secretRefs || [])) {
    if (sr.name && sr.mode === 'env') envFrom.push({ secretRef: { name: sr.name } })
  }

  const resources = {}
  const req = {}
  const lim = {}
  if (cpuReq?.trim()) req.cpu = cpuReq.trim()
  if (memReq?.trim()) req.memory = memReq.trim()
  if (cpuLim?.trim()) lim.cpu = cpuLim.trim()
  if (memLim?.trim()) lim.memory = memLim.trim()
  if (gpuEnabled && gpuCount > 0) {
    lim[gpuKey] = String(gpuCount)
    req[gpuKey] = String(gpuCount)
  }
  if (Object.keys(req).length) resources.requests = req
  if (Object.keys(lim).length) resources.limits = lim

  const container = {
    name: appName,
    image,
    imagePullPolicy: pullPolicy || 'Always',
    ...(containerEnv.length ? { env: containerEnv } : {}),
    ...(envFrom.length ? { envFrom } : {}),
    ...(volumeMounts.length ? { volumeMounts } : {}),
    ...(Object.keys(resources).length ? { resources } : {}),
  }

  const podSpec = {
    containers: [container],
    ...(podVolumes.length ? { volumes: podVolumes } : {}),
    ...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}),
  }

  const nodeSelector = {}
  const affinityTerms = []
  for (const rule of (placementRules || [])) {
    if (!rule.key?.trim()) continue
    if (rule.policy === 'Mandatory') {
      nodeSelector[rule.key.trim()] = rule.value || ''
    } else {
      affinityTerms.push({
        weight: 1,
        preference: { matchExpressions: [{ key: rule.key.trim(), operator: 'In', values: [rule.value || ''] }] },
      })
    }
  }
  if (Object.keys(nodeSelector).length) podSpec.nodeSelector = nodeSelector
  if (affinityTerms.length) {
    podSpec.affinity = { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: affinityTerms } }
  }

  const result = []

  if (deploymentType !== 'StatefulSet') {
    for (let i = 0; i < (volumes || []).length; i++) {
      const v = volumes[i]
      if (!v.mountPath) continue
      result.push({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: `${appName}-${i}`, namespace, labels },
        spec: {
          accessModes: [v.accessPolicy === 'shared' ? 'ReadWriteMany' : 'ReadWriteOnce'],
          resources: { requests: { storage: `${v.size || '1'}${v.sizeUnit || 'Gi'}` } },
          ...(v.storageClass ? { storageClassName: v.storageClass } : {}),
        },
      })
    }
  }

  if (deploymentType === 'Deployment') {
    result.push({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: appName, namespace, labels, annotations: ann },
      spec: {
        replicas: parseInt(String(instances), 10) || 1,
        selector: { matchLabels: { app: appName } },
        template: { metadata: { labels }, spec: podSpec },
      },
    })
  } else if (deploymentType === 'StatefulSet') {
    const vct = (volumes || []).map((v, i) => ({
      metadata: { name: `${appName}-${i}` },
      spec: {
        accessModes: [v.accessPolicy === 'shared' ? 'ReadWriteMany' : 'ReadWriteOnce'],
        resources: { requests: { storage: `${v.size || '1'}${v.sizeUnit || 'Gi'}` } },
        ...(v.storageClass ? { storageClassName: v.storageClass } : {}),
      },
    }))
    result.push({
      apiVersion: 'apps/v1', kind: 'StatefulSet',
      metadata: { name: appName, namespace, labels, annotations: ann },
      spec: {
        replicas: parseInt(String(instances), 10) || 1,
        selector: { matchLabels: { app: appName } },
        serviceName: appName,
        template: { metadata: { labels }, spec: podSpec },
        ...(vct.length ? { volumeClaimTemplates: vct } : {}),
      },
    })
  } else if (deploymentType === 'DaemonSet') {
    result.push({
      apiVersion: 'apps/v1', kind: 'DaemonSet',
      metadata: { name: appName, namespace, labels, annotations: ann },
      spec: {
        selector: { matchLabels: { app: appName } },
        template: { metadata: { labels }, spec: podSpec },
      },
    })
  }

  for (const svc of (services || [])) {
    if (!svc.containerPort) continue
    const svcName = services.length === 1 ? appName : `${appName}-${svc.type.toLowerCase()}`
    result.push({
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: svcName, namespace, labels },
      spec: {
        selector: { app: appName },
        type: svc.type,
        ports: [{ port: parseInt(String(svc.servicePort || svc.containerPort), 10), targetPort: parseInt(String(svc.containerPort), 10), protocol: svc.protocol || 'TCP' }],
      },
    })
    if (svc.ingressEnabled) {
      const ingMeta = { name: svcName, namespace, labels }
      if (svc.ingressClass) ingMeta.annotations = { 'kubernetes.io/ingress.class': svc.ingressClass }
      result.push({
        apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
        metadata: ingMeta,
        spec: {
          ...(svc.ingressClass ? { ingressClassName: svc.ingressClass } : {}),
          rules: [{ ...(svc.ingressHost ? { host: svc.ingressHost } : {}), http: { paths: [{ path: svc.ingressPath || '/', pathType: 'Prefix', backend: { service: { name: svcName, port: { number: parseInt(String(svc.servicePort || svc.containerPort), 10) } } } }] } }],
        },
      })
    }
  }

  if (autoScalingEnabled && deploymentType === 'Deployment') {
    result.push({
      apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler',
      metadata: { name: appName, namespace, labels },
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: appName },
        minReplicas: parseInt(String(minInstances), 10) || 1,
        maxReplicas: parseInt(String(maxInstances), 10) || 3,
        metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: parseInt(String(targetCpu), 10) || 70 } } }],
      },
    })
  }

  return result
}
