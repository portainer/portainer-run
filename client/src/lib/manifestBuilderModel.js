import { newId } from './deployFormModel.js'

export const DEPLOYMENT_TYPES = [
  { value: 'Deployment', label: 'Replicated', description: 'One or more instances of a stateless app' },
  { value: 'StatefulSet', label: 'StatefulSet', description: 'Stateful app with stable identity (databases, queues)' },
  { value: 'DaemonSet', label: 'Global', description: 'One instance on every cluster node' },
]

export const SERVICE_TYPES = ['ClusterIP', 'NodePort', 'LoadBalancer']
export const DATA_ACCESS_POLICIES = [
  { value: 'isolated', label: 'Isolated', description: 'Each instance gets its own volume (ReadWriteOnce)' },
  { value: 'shared', label: 'Shared', description: 'All instances share one volume (ReadWriteMany)' },
]

export function defaultEnvVar() {
  return { id: newId(), mode: 'plain', key: '', value: '', secretName: '', secretKey: '' }
}

export function defaultVolume() {
  return { id: newId(), mountPath: '/data', size: '1', sizeUnit: 'Gi', storageClass: '', accessPolicy: 'isolated' }
}

export function defaultService() {
  return {
    id: newId(),
    type: 'ClusterIP',
    containerPort: '',
    servicePort: '',
    protocol: 'TCP',
    ingressEnabled: false,
    ingressHost: '',
    ingressPath: '/',
    ingressClass: '',
  }
}

export function defaultPlacementRule() {
  return { id: newId(), key: '', value: '', policy: 'Mandatory' }
}

export function defaultConfigMapRef() {
  return { id: newId(), name: '', mode: 'env', mountPath: '' }
}

export function defaultSecretRef() {
  return { id: newId(), name: '', mode: 'env', mountPath: '' }
}

export function defaultManifestBuilderState() {
  return {
    // Step 1 — Target
    envId: '',
    namespace: '',
    manualNs: false,
    manualNsValue: '',

    // Step 2 — Application
    appName: '',
    deploymentType: 'Deployment',
    instances: 1,
    note: '',
    annotations: [],

    // Image
    image: '',
    pullSecret: '',
    pullPolicy: 'Always',

    // Environment
    envVars: [],
    configMapRefs: [],
    secretRefs: [],

    // Storage
    volumes: [],

    // Resources
    cpuReq: '',
    cpuLim: '',
    memReq: '',
    memLim: '',
    gpuEnabled: false,
    gpuCount: 1,
    gpuKey: 'nvidia.com/gpu',

    // Auto-scaling
    autoScalingEnabled: false,
    minInstances: 1,
    maxInstances: 3,
    targetCpu: 70,

    // Placement
    placementRules: [],

    // Publishing
    services: [],
  }
}
