/**
 * Minimal TypeScript models for the Kubernetes `apps/v1` Deployment objects the
 * client reads from the cluster. These cover the fields the UI actually touches
 * rather than the full Kubernetes API surface, and intentionally mark most
 * properties optional to match what the API may omit.
 */

export interface OwnerReference {
  apiVersion?: string
  kind: string
  name: string
  uid?: string
  controller?: boolean
}

export interface ObjectMeta {
  name: string
  namespace: string
  uid?: string
  creationTimestamp?: string
  resourceVersion?: string
  generation?: number
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: OwnerReference[]
}

export interface EnvVarSource {
  secretKeyRef?: { name: string; key: string }
  configMapKeyRef?: { name: string; key: string }
  fieldRef?: unknown
  resourceFieldRef?: unknown
}

export interface EnvVar {
  name: string
  value?: string
  valueFrom?: EnvVarSource
}

export interface ContainerPort {
  containerPort: number
  protocol?: string
}

export interface ResourceRequirements {
  requests?: { cpu?: string; memory?: string }
  limits?: { cpu?: string; memory?: string }
}

export interface VolumeMount {
  name: string
  mountPath: string
}

export interface Container {
  name: string
  image?: string
  imagePullPolicy?: string
  command?: string[]
  args?: string[]
  ports?: ContainerPort[]
  env?: EnvVar[]
  resources?: ResourceRequirements
  volumeMounts?: VolumeMount[]
}

export interface PodTemplateSpec {
  spec?: { containers?: Container[] }
}

export interface RollingUpdateDeployment {
  maxSurge?: string | number
  maxUnavailable?: string | number
}

export interface DeploymentStrategy {
  type?: string
  rollingUpdate?: RollingUpdateDeployment
}

export interface DeploymentSpec {
  replicas?: number
  strategy?: DeploymentStrategy
  template?: PodTemplateSpec
}

export interface DeploymentCondition {
  type: string
  status: string
  reason?: string
  message?: string
}

export interface DeploymentStatus {
  replicas?: number
  readyReplicas?: number
  updatedReplicas?: number
  availableReplicas?: number
  observedGeneration?: number
  conditions?: DeploymentCondition[]
}

/**
 * A Kubernetes Deployment enriched client-side with the owning Portainer
 * environment (`_envId`/`_envName`, added by `lib/deployments.js`).
 */
export interface Deployment {
  apiVersion?: string
  kind?: string
  metadata: ObjectMeta
  spec?: DeploymentSpec
  status?: DeploymentStatus
  _envId?: number
  _envName?: string
}

/** A Pod, covering only the fields the log/instance pickers read. */
export interface Pod {
  metadata: ObjectMeta
  spec?: { containers?: Container[] }
}

/** A ReplicaSet, as read by the deployment revision-history tab. */
export interface ReplicaSet {
  metadata: ObjectMeta
  spec?: { replicas?: number; template?: PodTemplateSpec }
  status?: { readyReplicas?: number }
}

/** A container entry from the metrics.k8s.io PodMetrics resource. */
export interface ContainerMetrics {
  name: string
  usage?: { cpu?: string; memory?: string }
}

/** A metrics.k8s.io PodMetrics sample for a single pod. */
export interface PodMetrics {
  metadata: { name: string; labels?: Record<string, string> }
  containers?: ContainerMetrics[]
}

/** Runtime guard for values returned by loosely-typed (JS) fetch helpers. */
export function isDeployment(value: unknown): value is Deployment {
  if (typeof value !== 'object' || value === null) return false
  if (!('metadata' in value)) return false
  const meta = value.metadata
  return typeof meta === 'object' && meta !== null
}
