import type { BadgeTone } from '@ds/v3-components/Badge/Badge'

import type { Deployment, EnvVar } from '../../types/k8s'

/** Derive the header status badge (label + tone) from a deployment's replicas. */
export function headerStatusFromDeployment(d: Deployment | null): {
  status: string
  statusLabel: string
  statusTone: BadgeTone
} {
  if (!d) {
    return { status: '', statusLabel: 'Loading…', statusTone: 'neutral' }
  }
  const ready = d.status?.readyReplicas || 0
  const desired = d.spec?.replicas || 0
  const conditions = d.status?.conditions || []
  const progressing = conditions.find(
    (c: { type: string }) => c.type === 'Progressing',
  )
  if (desired === 0) {
    return { status: 'stopped', statusLabel: 'Switched off', statusTone: 'neutral' }
  }
  if (ready >= desired) {
    return { status: 'running', statusLabel: 'Running', statusTone: 'success' }
  }
  if (ready > 0) {
    return { status: 'partial', statusLabel: 'Degraded', statusTone: 'warning' }
  }
  if (progressing?.status === 'True') {
    return { status: 'pending', statusLabel: 'Starting', statusTone: 'warning' }
  }
  return { status: 'error', statusLabel: 'Not available', statusTone: 'danger' }
}

/** Plain-language, business-builder friendly status line for the simple Overview. */
export function friendlyStatus(d: Deployment, reason: string | undefined) {
  const { status, statusLabel } = headerStatusFromDeployment(d)
  const base =
    status === 'running' ? 'Your app is live and running.'
      : status === 'stopped' ? 'Your app is switched off.'
      : status === 'pending' ? 'Your app is starting up.'
      : status === 'partial' ? 'Your app is running, but not fully healthy.'
      : status === 'error' ? "Your app isn't running right now."
      : statusLabel
  return { status, base, reason: reason || '' }
}

/** Display value for an env entry, resolving valueFrom references to a note. */
export function envDisplayValue(e: EnvVar): string {
  if (e.value != null) return e.value
  if (e.valueFrom?.secretKeyRef) {
    const r = e.valueFrom.secretKeyRef
    return `secret(${r.name}/${r.key})`
  }
  if (e.valueFrom?.configMapKeyRef) {
    const r = e.valueFrom.configMapKeyRef
    return `configmap(${r.name}/${r.key})`
  }
  if (e.valueFrom?.fieldRef) return '(fieldRef)'
  if (e.valueFrom?.resourceFieldRef) return '(resourceFieldRef)'
  return '*'
}
