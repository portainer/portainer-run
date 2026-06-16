import { kubeFetch } from './api.js'

/** @typedef {true | false | null} TriBool */

/**
 * @typedef {object} ReadinessCheckResult
 * @property {TriBool} ok — true = pass, false = fail, null = warn / N/A
 * @property {string} label
 * @property {string} detail
 */

/**
 * @param {string} token
 * @param {string|number} envId
 * @returns {Promise<ReadinessCheckResult>}
 */
export async function checkIngress(token, envId) {
  try {
    const [classR, podR] = await Promise.all([
      kubeFetch(token, envId, '/apis/networking.k8s.io/v1/ingressclasses'),
      kubeFetch(
        token,
        envId,
        `/api/v1/pods?fieldSelector=${encodeURIComponent('status.phase=Running')}`,
      ),
    ])
    const classData = classR.ok ? await classR.json() : { items: [] }
    const podData = podR.ok ? await podR.json() : { items: [] }
    const classes = classData.items || []
    const pods = podData.items || []
    const controllerPods = pods.filter((p) =>
      /ingress|nginx|traefik|haproxy|istio-ingressgateway|contour/i.test(
        JSON.stringify(p.metadata?.labels || {}) + (p.metadata?.name || ''),
      ),
    )
    if (classes.length > 0) {
      return {
        ok: true,
        label: classes.map((c) => c.metadata.name).join(', '),
        detail: `${classes.length} ingress type(s) defined`,
      }
    }
    if (controllerPods.length > 0) {
      return {
        ok: null,
        label: 'Controller found',
        detail: 'No IngressClass defined but controller pods running',
      }
    }
    return {
      ok: false,
      label: 'Not found',
      detail: 'No IngressClass or ingress controller pods detected',
    }
  } catch (e) {
    return { ok: false, label: 'Error', detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * @param {string} token
 * @param {string|number} envId
 * @returns {Promise<ReadinessCheckResult>}
 */
export async function checkLoadBalancer(token, envId) {
  try {
    const r = await kubeFetch(
      token,
      envId,
      `/api/v1/services?fieldSelector=${encodeURIComponent('spec.type=LoadBalancer')}`,
    )
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const svcs = (await r.json()).items || []
    const provisioned = svcs.filter(
      (s) => (s.status?.loadBalancer?.ingress || []).length > 0,
    )
    const pending = svcs.filter(
      (s) => (s.status?.loadBalancer?.ingress || []).length === 0,
    )
    if (provisioned.length > 0) {
      const ips = provisioned
        .map(
          (s) =>
            s.status.loadBalancer.ingress[0].ip ||
            s.status.loadBalancer.ingress[0].hostname ||
            '?',
        )
        .slice(0, 3)
        .join(', ')
      return {
        ok: true,
        label: 'Available',
        detail: `${provisioned.length} LB(s) provisioned — ${ips}`,
      }
    }
    if (svcs.length > 0) {
      return {
        ok: null,
        label: 'Pending',
        detail: `${pending.length} LB service(s) exist but no external IP assigned`,
      }
    }
    return {
      ok: null,
      label: 'No LB services',
      detail: 'No LoadBalancer-type services found — cannot confirm provisioner',
    }
  } catch (e) {
    return { ok: false, label: 'Error', detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * @param {string} token
 * @param {string|number} envId
 * @returns {Promise<ReadinessCheckResult>}
 */
export async function checkStorage(token, envId) {
  try {
    const r = await kubeFetch(token, envId, '/apis/storage.k8s.io/v1/storageclasses')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const classes = (await r.json()).items || []
    const defaultClass = classes.find(
      (sc) =>
        sc.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
    )
    if (defaultClass) {
      return {
        ok: true,
        label: defaultClass.metadata.name,
        detail: `${classes.length} storage type(s) — default: ${defaultClass.metadata.name}`,
      }
    }
    if (classes.length > 0) {
      return {
        ok: null,
        label: 'No default',
        detail: `${classes.length} type(s) exist but none marked as default`,
      }
    }
    return { ok: false, label: 'None defined', detail: 'No storage types found in this cluster' }
  } catch (e) {
    return { ok: false, label: 'Error', detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * @param {string} token
 * @param {string|number} envId
 * @returns {Promise<ReadinessCheckResult>}
 */
export async function checkNodes(token, envId) {
  try {
    const r = await kubeFetch(token, envId, '/api/v1/nodes')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const nodes = (await r.json()).items || []
    const ready = nodes.filter((n) =>
      (n.status?.conditions || []).some(
        (c) => c.type === 'Ready' && c.status === 'True',
      ),
    )
    const notReady = nodes.length - ready.length
    if (nodes.length === 0) {
      return { ok: false, label: 'No nodes', detail: 'No nodes returned' }
    }
    if (notReady === 0) {
      return {
        ok: true,
        label: `${ready.length} / ${nodes.length} ready`,
        detail: 'All nodes in Ready state',
      }
    }
    if (ready.length > 0) {
      return {
        ok: null,
        label: `${ready.length} / ${nodes.length} ready`,
        detail: `${notReady} node(s) not ready`,
      }
    }
    return {
      ok: false,
      label: 'All nodes down',
      detail: `${nodes.length} node(s), none in Ready state`,
    }
  } catch (e) {
    return { ok: false, label: 'Error', detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * @param {string} token
 * @param {string|number} envId
 * @returns {Promise<ReadinessCheckResult[]>} order: Ingress, LoadBalancer, Storage, Nodes
 */
export async function runReadinessForEnv(token, envId) {
  return Promise.all([
    checkIngress(token, envId),
    checkLoadBalancer(token, envId),
    checkStorage(token, envId),
    checkNodes(token, envId),
  ])
}

/**
 * @param {ReadinessCheckResult[]} results
 * @returns {'ready' | 'issues' | 'warnings' | 'checking'}
 */
export function overallEnvStatus(results) {
  const allOk = results.length > 0 && results.every((r) => r.ok === true)
  const anyFail = results.some((r) => r.ok === false)
  if (allOk) return 'ready'
  if (anyFail) return 'issues'
  return 'warnings'
}
