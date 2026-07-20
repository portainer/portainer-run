/**
 * Minimal TypeScript models for the Kubernetes `apps/v1` Deployment objects the
 * client reads from the cluster. These cover the fields the UI actually touches
 * rather than the full Kubernetes API surface, and intentionally mark most
 * properties optional to match what the API may omit.
 */

export interface ObjectMeta {
  name: string
  namespace: string
  creationTimestamp?: string
  resourceVersion?: string
  generation?: number
  labels?: Record<string, string>
  annotations?: Record<string, string>
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
