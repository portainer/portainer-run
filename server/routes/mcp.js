/**
 * MCP (Model Context Protocol) endpoint for Portainer Run.
 *
 * Exposes Vibe Deploy capabilities to AI coding tools (Claude, etc.) via
 * the MCP JSON-RPC protocol over plain HTTP.
 *
 * Transport:  POST /mcp
 * Auth:       Authorization: Bearer <portainer-token>  OR  X-API-Key: <token>
 *
 * Tools (feature-flag gated):
 *   list_environments   — Kubernetes environments available in Portainer
 *   list_namespaces     — Namespaces for a given environment
 *   list_git_targets    — Git targets accessible to the caller
 *   deploy_vibe_app     — Deploy app source files via Vibe Deploy pipeline
 *   get_app_status      — Running status of a deployed app
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import { readBody } from '../lib/http.js'
import { CORS } from '../lib/cors.js'
import { CACHE_FILE } from '../config.js'
import {
  FEATURE_VIBE_DEPLOY,
  FEATURE_SIMPLE_DEPLOY,
  FEATURE_MANIFEST_BUILDER,
  BASE_DOMAIN,
} from '../config.js'
import { resolveCallerIdentity, extractToken, portainerGet } from '../lib/identity.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'
import { getConnectionsForUser } from '../models/connection.js'
import { handleVibe } from './vibe.js'

const MCP_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'portainer-run', version: '1.0.0' }

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function buildTools() {
  const tools = []

  tools.push({
    name: 'list_environments',
    description: 'List available Kubernetes environments in Portainer. Call this first to find the envId needed for deployment.',
    inputSchema: { type: 'object', properties: {} },
  })

  tools.push({
    name: 'list_namespaces',
    description: 'List Kubernetes namespaces available in a specific environment.',
    inputSchema: {
      type: 'object',
      required: ['envId'],
      properties: {
        envId: { type: 'string', description: 'Environment ID from list_environments' },
      },
    },
  })

  tools.push({
    name: 'list_git_targets',
    description: 'List git repositories configured in Portainer Run. These are used to store deployment manifests. Call this to find the gitTargetId needed for deployment.',
    inputSchema: { type: 'object', properties: {} },
  })

  if (FEATURE_VIBE_DEPLOY) {
    tools.push({
      name: 'deploy_vibe_app',
      description:
        'Deploy an application to Kubernetes via Portainer Run. Pass the source files directly — ' +
        'runtime detection, dependency installation, git commit, and Kubernetes deployment are all ' +
        'handled automatically. Use list_environments, list_namespaces, and list_git_targets first ' +
        'to get the required IDs.',
      inputSchema: {
        type: 'object',
        required: ['appName', 'envId', 'namespace', 'gitTargetId', 'files'],
        properties: {
          appName: {
            type: 'string',
            description: 'Application name — lowercase alphanumeric and hyphens only, e.g. my-expense-tracker',
          },
          envId: {
            type: 'string',
            description: 'Target Kubernetes environment ID (from list_environments)',
          },
          namespace: {
            type: 'string',
            description: 'Kubernetes namespace to deploy into (from list_namespaces)',
          },
          gitTargetId: {
            type: 'string',
            description: 'Git target ID for manifest storage (from list_git_targets)',
          },
          files: {
            type: 'array',
            description: 'Application source files',
            items: {
              type: 'object',
              required: ['path', 'content'],
              properties: {
                path: { type: 'string', description: 'Relative file path, e.g. server.js or public/index.html' },
                content: { type: 'string', description: 'File content as a string' },
              },
            },
          },
          envVars: {
            type: 'array',
            description: 'Environment variables for the app. Auto-detected from .env.example in files if omitted.',
            items: {
              type: 'object',
              required: ['key', 'value'],
              properties: {
                key: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
          exposeType: {
            type: 'string',
            enum: ['none', 'NodePort', 'LoadBalancer', 'Ingress'],
            description: 'How to expose the app externally. Default: NodePort.',
          },
          ingress: {
            type: 'object',
            description:
              'Ingress settings, used only when exposeType is "Ingress". If host is omitted and a base domain is configured, defaults to <appName>.<baseDomain>.',
            properties: {
              host: { type: 'string', description: 'Ingress hostname, e.g. my-app.example.com' },
              path: { type: 'string', description: 'Ingress path. Default: /' },
              ingressClass: { type: 'string', description: 'Ingress class name, e.g. nginx' },
            },
          },
          branch: {
            type: 'string',
            description: 'Git branch for manifests. Default: main.',
          },
        },
      },
    })
  }

  tools.push({
    name: 'get_app_status',
    description: 'Get the running status of a deployed application.',
    inputSchema: {
      type: 'object',
      required: ['appName', 'envId', 'namespace'],
      properties: {
        appName: { type: 'string', description: 'Application name' },
        envId: { type: 'string', description: 'Environment ID' },
        namespace: { type: 'string', description: 'Kubernetes namespace' },
      },
    },
  })

  return tools
}

// ---------------------------------------------------------------------------
// Tool implementations — reuse existing server logic directly
// ---------------------------------------------------------------------------

async function toolListEnvironments(req) {
  const token = extractToken(req)
  const target = resolvePortainerTarget(req)
  if (!target) throw new Error('Cannot resolve Portainer target — ensure PORTAINER_URL is set or send X-Portainer-URL header')

  const eps = await portainerGet(target, token, '/api/endpoints')
  const K8S_TYPES = [1, 7]
  const k8sEnvs = (Array.isArray(eps) ? eps : []).filter((e) => K8S_TYPES.includes(e.Type))
  return k8sEnvs.map((e) => ({ id: String(e.Id), name: e.Name, type: e.Type === 7 ? 'agent' : 'local' }))
}

async function toolListNamespaces(req, args) {
  const { envId } = args
  if (!envId) throw new Error('envId is required')
  // Validate envId is numeric to prevent path injection into Portainer API
  if (!/^\d+$/.test(String(envId))) throw new Error('envId must be a numeric environment ID')
  const token = extractToken(req)
  const target = resolvePortainerTarget(req)
  if (!target) throw new Error('Cannot resolve Portainer target')

  const data = await portainerGet(target, token, `/api/endpoints/${envId}/kubernetes/api/v1/namespaces`)
  const items = data?.items || []
  const SYSTEM = new Set(['kube-system', 'kube-public', 'kube-node-lease'])
  return items
    .map((n) => n.metadata?.name)
    .filter((n) => n && !SYSTEM.has(n))
}

async function toolListGitTargets(req, caller) {
  const conns = getConnectionsForUser(caller.userId)
  return conns.map((c) => ({
    id: c.id,
    name: c.name,
    repo: c.payload?.repo,
    provider: c.payload?.provider,
    defaultBranch: c.payload?.defaultBranch || 'main',
    shared: c.shared,
  }))
}

// ---------------------------------------------------------------------------
// Runtime detection (server-side mirror of client/src/components/VibeDeploy.jsx)
//
// The browser UI fills runtime/runtimeImage/startCmd/workDir/port before calling
// the deploy backend. The MCP path has no UI, so without this it would always
// deploy a bare node:20-alpine image with no start command — which crashloops.
// Keep this in sync with the RUNTIMES table in VibeDeploy.jsx.
// ---------------------------------------------------------------------------

const NGINX_RUNTIME = {
  id: 'nginx',
  image: 'nginx:alpine',
  defaultCmd: () => "nginx -g 'daemon off;'",
  port: 80,
  workDir: '/usr/share/nginx/html',
}

const RUNTIMES = [
  {
    id: 'node',
    image: 'node:20-alpine',
    detect: (names) => names.includes('package.json'),
    defaultCmd: (files) => {
      const pkg = files.find((f) => f.name === 'package.json')
      if (pkg) {
        try {
          const parsed = JSON.parse(pkg.text)
          if (parsed?.scripts?.start) return 'npm start'
        } catch { /* ignore */ }
      }
      const hasServerJs = files.some((f) => f.name === 'server.js' || f.name === 'index.js')
      return hasServerJs ? `node ${files.find((f) => f.name === 'server.js') ? 'server.js' : 'index.js'}` : 'npm start'
    },
    port: 3000,
    workDir: '/app',
  },
  {
    id: 'python',
    image: 'python:3.12-slim',
    detect: (names) => names.includes('requirements.txt') || names.some((n) => n.endsWith('.py')),
    defaultCmd: (files) => {
      for (const candidate of ['main.py', 'app.py', 'server.py', 'run.py']) {
        if (files.some((f) => f.name === candidate)) return `python ${candidate}`
      }
      return 'python app.py'
    },
    port: 8000,
    workDir: '/app',
  },
  {
    id: 'php',
    image: 'php:8.3-apache',
    detect: (names) => names.some((n) => n.endsWith('.php')),
    defaultCmd: () => 'apache2-foreground',
    port: 80,
    workDir: '/var/www/html',
  },
  {
    id: 'ruby',
    image: 'ruby:3.3-alpine',
    detect: (names) => names.includes('Gemfile') || names.some((n) => n.endsWith('.rb')),
    defaultCmd: (files) => {
      for (const candidate of ['app.rb', 'server.rb', 'config.ru']) {
        if (files.some((f) => f.name === candidate)) {
          return candidate === 'config.ru' ? 'bundle exec rackup -p 9292 -o 0.0.0.0' : `ruby ${candidate}`
        }
      }
      return 'bundle exec ruby app.rb'
    },
    port: 9292,
    workDir: '/app',
  },
]

/**
 * Detects the runtime from a list of MCP files ({ path, content }).
 * Returns { id, image, startCmd, workDir, port }.
 */
function detectRuntimeForFiles(files) {
  // Map MCP { path, content } → { name, text } used by the detection table.
  const mapped = files.map((f) => ({
    name: (f.path || '').split('/').pop(),
    text: f.content,
  }))
  const names = mapped.map((f) => f.name)

  // Static sites (all assets static) and the no-match case both default to nginx.
  const rt = RUNTIMES.find((r) => r.detect(names)) || NGINX_RUNTIME

  return {
    id: rt.id,
    image: rt.image,
    startCmd: rt.defaultCmd(mapped),
    workDir: rt.workDir,
    port: rt.port,
  }
}

async function toolDeployVibeApp(req, args, caller) {
  if (!FEATURE_VIBE_DEPLOY) throw new Error('Vibe Deploy is not enabled on this Portainer Run instance')

  const {
    appName, envId, namespace, gitTargetId,
    files = [], envVars, exposeType = 'NodePort', ingress = {}, branch = 'main',
  } = args

  if (!appName || !envId || !namespace || !gitTargetId || !files.length) {
    throw new Error('appName, envId, namespace, gitTargetId, and files are all required')
  }

  const safeAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  // Resolve ingress settings. When exposing via Ingress without an explicit host,
  // fall back to <appName>.<BASE_DOMAIN> if a base domain is configured — mirroring
  // the template/UI default. Without a host, buildVibeManifests skips the Ingress.
  const resolvedIngress = exposeType === 'Ingress'
    ? {
        host: ingress.host || (BASE_DOMAIN ? `${safeAppName}.${BASE_DOMAIN}` : ''),
        path: ingress.path || '/',
        ...(ingress.ingressClass ? { ingressClass: ingress.ingressClass } : {}),
      }
    : {}

  if (exposeType === 'Ingress' && !resolvedIngress.host) {
    throw new Error('exposeType "Ingress" requires ingress.host (or a configured BASE_DOMAIN)')
  }

  // Detect runtime, image, start command, working dir, and port from the files —
  // the UI does this client-side; without it the MCP deploy crashloops.
  const detected = detectRuntimeForFiles(files)

  // Auto-detect env vars from .env.example if not provided
  let resolvedEnvVars = envVars
  if (!resolvedEnvVars) {
    const envExample = files.find((f) => f.path === '.env.example' || f.path.endsWith('/.env.example'))
    if (envExample) {
      resolvedEnvVars = envExample.content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const eq = l.indexOf('=')
          return { key: l.slice(0, eq).trim(), value: l.slice(eq + 1).trim() }
        })
    } else {
      resolvedEnvVars = []
    }
  }

  // Build a minimal stream-compatible mock request
  const token = extractToken(req)
  const portainerUrl = req.headers['x-portainer-url'] || req.headers['X-Portainer-URL'] || ''
  const mockBodyBuf = Buffer.from(JSON.stringify({
    gitTargetId,
    branch,
    pathPrefix: '',
    pollInterval: '5m',
    envId,
    envName: '',
    deployParams: {
      appName: safeAppName,
      ns: namespace,
      instances: 1,
      exposeType,
      servicePorts: [detected.port],
      ingress: resolvedIngress,
    },
    vibeParams: {
      runtime: detected.id,
      runtimeImage: detected.image,
      startCmd: detected.startCmd,
      workDir: detected.workDir,
      envVars: resolvedEnvVars,
      sourceType: 'upload',
      sourceFiles: files.map((f) => ({ path: f.path, content: f.content })),
      gitSource: null,
    },
  }))

  const mockReq = {
    method: 'POST',
    url: '/api/vibe/deploy',
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
      ...(portainerUrl ? { 'x-portainer-url': portainerUrl } : {}),
    },
    on(event, handler) {
      if (event === 'data') process.nextTick(() => handler(mockBodyBuf))
      if (event === 'end') process.nextTick(() => handler())
      if (event === 'error') { /* no-op */ }
      return this
    },
  }

  let result = null
  await new Promise((resolve, reject) => {
    const mockRes = {
      statusCode: 200,
      writeHead(code) { this.statusCode = code },
      end(body) { this._body = body || ''; resolve(this) },
    }
    handleVibe(mockReq, mockRes, '/api/vibe/deploy').catch(reject)
  }).then((r) => { result = r })

  if (result.statusCode >= 400) {
    let errMsg = 'Deploy failed'
    try { errMsg = JSON.parse(result._body)?.error || errMsg } catch { /* ignore */ }
    throw new Error(errMsg)
  }

  let data = {}
  try { data = JSON.parse(result._body) } catch { /* ignore */ }
  return {
    ok: true,
    appName: data.appName || appName,
    namespace,
    envId,
    message: `${data.appName || appName} deployed to ${namespace} successfully — view it in the Applications page`,
  }
}

async function toolGetAppStatus(req, args) {
  const { appName, envId, namespace } = args
  const token = extractToken(req)
  const target = resolvePortainerTarget(req)

  // Compute cache key the same way server/cache.js does: sha256(token:target.key)
  let deployments = []
  try {
    if (target && fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      const cacheKey = crypto.createHash('sha256').update(token + ':' + target.key).digest('hex')
      const entry = cache[cacheKey] || {}
      deployments = entry.deployments || []
    }
  } catch { /* cache miss */ }

  const dep = deployments.find(
    (d) => d.name === appName && String(d.envId) === String(envId) && d.namespace === namespace
  )

  if (!dep) {
    return { found: false, message: `No application found for ${appName} in ${namespace}` }
  }

  return {
    found: true,
    appName: dep.name,
    namespace: dep.namespace,
    status: dep.status || 'unknown',
    ready: dep.readyReplicas || 0,
    desired: dep.replicas || 1,
    image: dep.image,
    nodePort: dep.nodePort || null,
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------

async function dispatch(method, params, req, caller) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }

    case 'tools/list':
      return { tools: buildTools() }

    case 'tools/call': {
      const { name, arguments: args = {} } = params
      let toolResult
      switch (name) {
        case 'list_environments':
          toolResult = await toolListEnvironments(req)
          break
        case 'list_namespaces':
          toolResult = await toolListNamespaces(req, args)
          break
        case 'list_git_targets':
          toolResult = await toolListGitTargets(req, caller)
          break
        case 'deploy_vibe_app':
          toolResult = await toolDeployVibeApp(req, args, caller)
          break
        case 'get_app_status':
          toolResult = await toolGetAppStatus(req, args)
          break
        default:
          throw { code: -32601, message: `Unknown tool: ${name}` }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
      }
    }

    case 'notifications/initialized':
      return null // notification — no response

    default:
      throw { code: -32601, message: `Method not found: ${method}` }
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleMcp(req, res) {
  // Auth — resolve caller identity
  const caller = await resolveCallerIdentity(req)
  if (!caller) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized — provide a Portainer API token via Authorization: Bearer <token> or X-API-Key header' } }))
    return
  }

  const body = await readBody(req)
  let rpc
  try {
    rpc = JSON.parse(body.toString('utf8'))
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }

  const { jsonrpc, id, method, params } = rpc

  // Notifications have no id and expect no response
  if (method?.startsWith('notifications/')) {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  try {
    const result = await dispatch(method, params || {}, req, caller)
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  } catch (err) {
    const isRpcError = err && typeof err.code === 'number'
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: isRpcError
        ? err
        : { code: -32603, message: err?.message || 'Internal error' },
    }))
  }
}
