import { kubeFetch } from '../../lib/api.js'
import { inflightDedupe } from '../../lib/inflightDedupe.js'

/**
 * @returns {Promise<{ rows: [string, string][], emptyMessage?: string, error?: string }>}
 */
export async function fetchExposureDetail(token, envId, ns, name) {
  return inflightDedupe(`exposure:${envId}:${ns}:${name}`, async () => {
  try {
    const [svcRes, ingRes] = await Promise.all([
      kubeFetch(
        token,
        envId,
        `/api/v1/namespaces/${ns}/services?labelSelector=${encodeURIComponent('app=' + name)}`,
      ),
      kubeFetch(
        token,
        envId,
        `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses?labelSelector=${encodeURIComponent('app=' + name)}`,
      ),
    ])
    const svcs = svcRes.ok ? (await svcRes.json()).items || [] : []
    const ings = ingRes.ok ? (await ingRes.json()).items || [] : []

    if (!svcs.length && !ings.length) {
      return {
        rows: [],
        emptyMessage: 'No Service or Ingress found — deployment is not externally exposed.',
      }
    }

    /** @type {[string, string][]} */
    const rows = []

    for (const svc of svcs) {
      const type = svc.spec?.type || 'ClusterIP'
      const ports = svc.spec?.ports || []
      if (type === 'ClusterIP') {
        rows.push(['Type', 'ClusterIP (internal only)'])
        for (const p of ports) {
          rows.push(['Port', `${p.port}/${p.protocol || 'TCP'} → container ${p.targetPort}`])
        }
      } else if (type === 'NodePort') {
        rows.push(['Type', 'NodePort'])
        for (const p of ports) {
          rows.push(['Port', `${p.port} → node port ${p.nodePort} → container ${p.targetPort}`])
        }
      } else if (type === 'LoadBalancer') {
        const ingress = svc.status?.loadBalancer?.ingress?.[0]
        const external = ingress?.ip || ingress?.hostname || 'Pending (no external IP yet)'
        rows.push(['Type', 'LoadBalancer'])
        rows.push(['External', external])
        for (const p of ports) {
          rows.push(['Port', `${p.port} → container ${p.targetPort}`])
        }
      }
    }

    for (const ing of ings) {
      const cls =
        ing.spec?.ingressClassName ||
        ing.metadata?.annotations?.['kubernetes.io/ingress.class'] ||
        '—'
      rows.push(['Type', `Ingress (class: ${cls})`])
      for (const rule of ing.spec?.rules || []) {
        const host = rule.host || '*'
        for (const p of rule.http?.paths || []) {
          rows.push([
            'Route',
            `${host}${p.path} → port ${p.backend?.service?.port?.number || '—'}`,
          ])
        }
      }
    }

    return { rows }
  } catch (e) {
    return { rows: [], error: e?.message || 'Request failed' }
  }
  })
}
