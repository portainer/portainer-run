import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { CORS } from './lib/cors.js'
import { createLimiter } from './lib/limit.js'
import { resolvePortainerTarget } from './resolve-portainer.js'

const STATUS_TTL = 20 * 1000

const statusCache = new Map()
const kubeLimit = createLimiter(10)

/**
 * @param {string} token
 * @param {string} envId
 * @param {string} kubePath
 * @param {{ host: string, port: number, isHttps: boolean, key: string }} target
 */
function kubeCall(token, envId, kubePath, target) {
  return kubeLimit(
    () =>
      new Promise((resolve, reject) => {
        const upPath = `/api/endpoints/${envId}/kubernetes${kubePath}`
        const headers = { Accept: 'application/json', 'X-API-Key': token }
        const transport = target.isHttps ? https : http
        const req = transport.request(
          {
            hostname: target.host,
            port: target.port,
            path: upPath,
            method: 'GET',
            headers,
            rejectUnauthorized: false,
          },
          (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              try {
                resolve({
                  status: res.statusCode,
                  body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                })
              } catch {
                resolve({ status: res.statusCode, body: {} })
              }
            })
          }
        )
        req.on('error', reject)
        req.end()
      })
  )
}

function resolveStatusReason(pod) {
  const scheduledCond = (pod.status?.conditions || []).find(
    (c) => c.type === 'PodScheduled'
  )
  if (scheduledCond?.status === 'False') {
    const msg = (scheduledCond.message || '').toLowerCase()
    if (
      msg.includes('nvidia.com/gpu') ||
      msg.includes('amd.com/gpu') ||
      msg.includes('gpu.intel.com') ||
      msg.includes('insufficient gpu')
    )
      return 'No GPU node available'
    if (
      msg.includes('insufficient cpu') ||
      msg.includes('insufficient memory') ||
      msg.includes('nodes are available')
    )
      return 'No node has enough resources'
    if (
      msg.includes('node selector') ||
      msg.includes('affinity') ||
      msg.includes('taint') ||
      msg.includes("didn't match") ||
      msg.includes('tolerat')
    )
      return 'No compatible node found'
    return 'Cannot be scheduled'
  }
  const allCS = [
    ...(pod.status?.containerStatuses || []),
    ...(pod.status?.initContainerStatuses || []),
  ]
  if (pod.status?.phase === 'Pending' && !allCS.length) return 'Waiting for a node'

  // Init containers running — surface a meaningful message by name
  const runningInit = (pod.status?.initContainerStatuses || []).find(
    (cs) => cs.state?.running && !cs.ready
  )
  if (runningInit) {
    switch (runningInit.name) {
      case 'vibe-sync':    return 'Downloading your app files...'
      case 'vibe-install': return 'Installing dependencies...'
      case 'vibe-env':     return 'Applying settings...'
      default:             return 'Getting ready...'
    }
  }
  for (const cs of allCS) {
    const waiting = cs.state?.waiting
    const terminated = cs.state?.terminated
    const restarts = cs.restartCount || 0
    if (waiting?.reason) {
      switch (waiting.reason) {
        case 'ImagePullBackOff':
        case 'ErrImagePull':
          return "Can't download the image"
        case 'InvalidImageName':
          return 'Image name is invalid'
        case 'CrashLoopBackOff':
          return `App keeps crashing (${restarts} restart${restarts !== 1 ? 's' : ''})`
        case 'CreateContainerError':
        case 'RunContainerError':
          return 'Failed to start the container'
        case 'CreateContainerConfigError':
          return 'Missing config or secret'
        case 'ContainerCreating':
          return null
        default:
          return waiting.reason
      }
    }
    if (terminated) {
      if (terminated.reason === 'OOMKilled' && restarts >= 3)
        return `Hitting memory limit (${restarts} restart${restarts !== 1 ? 's' : ''})`
      if (terminated.exitCode > 0 && restarts >= 3)
        return `Exiting with errors (${restarts} restart${restarts !== 1 ? 's' : ''})`
    }
  }
  return null
}

export function resolveUrl(appName, svcs, ings, nodeIp) {
  for (const ing of ings.filter(
    (i) => i.metadata?.labels?.app === appName || i.metadata?.name === appName
  )) {
    for (const rule of ing.spec?.rules || []) {
      const host = rule.host
      if (!host) continue
      const tls = ing.spec?.tls?.some(
        (t) => !t.hosts || t.hosts.includes(host)
      )
      const scheme = tls ? 'https' : 'http'
      const pathStr = rule.http?.paths?.[0]?.path || '/'
      return {
        url: `${scheme}://${host}${pathStr === '/' ? '' : pathStr}`,
        label: host,
        type: 'ingress',
      }
    }
  }
  for (const svc of svcs.filter(
    (s) =>
      s.spec?.type === 'LoadBalancer' &&
      (s.metadata?.labels?.app === appName || s.metadata?.name === appName)
  )) {
    const entry = svc.status?.loadBalancer?.ingress?.[0]
    const external = entry?.ip || entry?.hostname
    const port = svc.spec?.ports?.[0]?.port
    if (external) {
      return {
        url: `http://${external}:${port}`,
        label: `${external}:${port}`,
        type: 'lb',
      }
    }
    return { url: null, label: 'Pending', type: 'lb' }
  }
  for (const svc of svcs.filter(
    (s) =>
      s.spec?.type === 'NodePort' &&
      (s.metadata?.labels?.app === appName || s.metadata?.name === appName)
  )) {
    const nodePort = svc.spec?.ports?.[0]?.nodePort
    if (nodePort && nodeIp) {
      return {
        url: `http://${nodeIp}:${nodePort}`,
        label: `${nodeIp}:${nodePort}`,
        type: 'nodeport',
      }
    }
    if (nodePort) return { url: null, label: `:${nodePort}`, type: 'nodeport' }
  }
  return null
}

/**
 * @param {string} token
 * @param {string} envId
 * @param {{ host: string, port: number, isHttps: boolean, key: string }} target
 * @param {string[]} namespaces  Known namespaces for this user — used as fallback when cluster-level calls return 403
 */
async function buildEnvStatus(token, envId, target, namespaces = []) {
  const labelSel = encodeURIComponent('managed-by=portainer-run')
  const [podsR, svcsR, ingsR, nodesR] = await Promise.all([
    kubeCall(token, envId, '/api/v1/pods?labelSelector=' + labelSel, target),
    kubeCall(token, envId, '/api/v1/services?labelSelector=' + labelSel, target),
    kubeCall(token, envId, '/apis/networking.k8s.io/v1/ingresses?labelSelector=' + labelSel, target),
    kubeCall(token, envId, '/api/v1/nodes', target),
  ])

  let pods = podsR.status === 200 ? podsR.body.items || [] : []
  let svcs = svcsR.status === 200 ? svcsR.body.items || [] : []
  let ings = ingsR.status === 200 ? ingsR.body.items || [] : []
  const nodes = nodesR.status === 200 ? nodesR.body.items || [] : []

  // Namespace-scoped fallback for users without cluster-level list permissions.
  // If pods or services returned 403 and the client supplied known namespaces,
  // retry with per-namespace scoped calls — same pattern fetchExposureDetail uses.
  if ((podsR.status === 403 || svcsR.status === 403) && namespaces.length > 0) {
    const nsResults = await Promise.all(
      namespaces.flatMap((ns) => [
        kubeCall(token, envId, `/api/v1/namespaces/${ns}/pods?labelSelector=${labelSel}`, target),
        kubeCall(token, envId, `/api/v1/namespaces/${ns}/services?labelSelector=${labelSel}`, target),
        kubeCall(token, envId, `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses?labelSelector=${labelSel}`, target),
      ])
    )
    pods = []
    svcs = []
    ings = []
    for (let i = 0; i < nsResults.length; i += 3) {
      if (nsResults[i].status === 200)     pods.push(...(nsResults[i].body.items || []))
      if (nsResults[i + 1].status === 200) svcs.push(...(nsResults[i + 1].body.items || []))
      if (nsResults[i + 2].status === 200) ings.push(...(nsResults[i + 2].body.items || []))
    }
  }

  let nodeIp = null
  for (const node of nodes) {
    const addrs = node.status?.addresses || []
    const ext = addrs.find((a) => a.type === 'ExternalIP')
    const int = addrs.find((a) => a.type === 'InternalIP')
    nodeIp = ext?.address || int?.address
    if (nodeIp) break
  }
  // For namespace-scoped users /api/v1/nodes returns 403 so nodeIp stays null.
  // Fall back to the Portainer host — not the node's real external IP, but gives
  // a clickable URL for NodePort services on typical single-node or internal clusters.
  if (!nodeIp && nodesR.status === 403) {
    nodeIp = target.host
  }

  const podsByApp = {}
  for (const pod of pods) {
    const app = pod.metadata?.labels?.app
    if (!app) continue
    ;(podsByApp[app] = podsByApp[app] || []).push(pod)
  }

  const result = {}
  const appNames = new Set([
    ...Object.keys(podsByApp),
    ...svcs.map((s) => s.metadata?.labels?.app).filter(Boolean),
  ])

  for (const appName of appNames) {
    const appPods = podsByApp[appName] || []
    let statusReason = null
    for (const pod of appPods) {
      statusReason = resolveStatusReason(pod)
      if (statusReason) break
    }
    const access = resolveUrl(appName, svcs, ings, nodeIp)
    result[appName] = {
      statusReason,
      accessUrl: access?.url || null,
      accessLabel: access?.label || null,
    }
  }

  return result
}

setInterval(() => {
  const now = Date.now()
  for (const [k, v] of statusCache) {
    if (v.expiresAt < now) statusCache.delete(k)
  }
}, 2 * 60 * 1000)

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} envId
 */
export async function handleEnvStatus(req, res, envId) {
  if (req.method !== 'GET') {
    res.writeHead(405, CORS)
    res.end()
    return
  }
  const token = req.headers['x-api-key'] || ''
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: 'X-API-Key required' }))
    return
  }
  const target = resolvePortainerTarget(req)
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
    res.end(
      JSON.stringify({
        error:
          'Set PORTAINER_URL on the server, or send the X-Portainer-URL header (your Portainer base URL).',
      })
    )
    return
  }

  // Parse namespace hints supplied by the client (?ns=james-namespace,other-ns)
  const qs = (req.url || '').split('?')[1] || ''
  const nsParam = new URLSearchParams(qs).get('ns') || ''
  const namespaces = nsParam.split(',').filter(Boolean)

  const ck = crypto
    .createHash('sha256')
    .update(token + ':' + envId + ':' + target.key)
    .digest('hex')
  const now = Date.now()
  const cached = statusCache.get(ck)
  if (cached && cached.expiresAt > now) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ cached: true, data: cached.data }))
    return
  }
  try {
    const data = await buildEnvStatus(token, envId, target, namespaces)
    statusCache.set(ck, { data, expiresAt: now + STATUS_TTL })
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ cached: false, data }))
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    console.error(`[env-status] env=${envId}`, err.message)
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: err.message }))
  }
}
