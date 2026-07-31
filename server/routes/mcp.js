/**
 * MCP (Model Context Protocol) endpoint for Portainer-Run.
 *
 * Exposes Vibe Deploy capabilities to AI coding tools (Claude, etc.) via
 * the MCP JSON-RPC protocol over plain HTTP.
 *
 * Transport:  POST /mcp
 * Auth:       Authorization: Bearer <portainer-token>  OR  X-API-Key: <token>
 *
 * Tools:
 *   list_environments   — Kubernetes environments available in Portainer
 *   list_namespaces     — Namespaces for a given environment
 *   list_git_targets    — Git targets accessible to the caller
 *   deploy_app          — Deploy app source files via the Deploy pipeline
 *   get_app_status      — Running status of a deployed app
 */

import { readBody } from '../lib/http.js'
import { CORS } from '../lib/cors.js'
import { BASE_DOMAIN, CONFIG_NAMESPACE, GATEWAY_URL } from '../config.js'
import { requestUploadSession, fetchStagedFiles } from '../lib/gateway.js'
import {
  resolveCallerIdentity,
  extractToken,
  portainerGet,
} from '../lib/identity.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'
import { getConnectionsForUser } from '../models/connection.js'
import { handleVibe } from './vibe.js'
import { resolveUrl } from '../env-status.js'

const MCP_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'portainer-run', version: '1.0.0' }

// Server-level guidance surfaced to the model by compliant MCP clients
// (returned in the initialize response). This makes the deploy workflow
// self-describing so the user does not have to prompt for it — the model
// is told to gather the info the tool schema cannot enforce on its own.
const SERVER_INSTRUCTIONS = [
  'Portainer-Run deploys applications to Kubernetes from source files via the deploy_app tool.',
  '',
  'FILE TRANSFER — all files are uploaded to the gateway, then deployed:',
  '    1. Call request_upload_session — returns { sessionId, uploadUrl, expiresAt }.',
  '    2. POST the file array as JSON to uploadUrl: Array<{ path: string, content: string }>.',
  '    3. Call deploy_app with that stagedSessionId.',
  '  The session is single-use and expires in 5 minutes — upload and deploy immediately.',
  '',
  'CRITICAL — upload exact, complete files: each uploaded file must contain the COMPLETE content of that file. Never upload a placeholder, summary, description, ellipsis ("..."), a comment like "<!-- content here -->" or "// rest of file", or any truncated or abbreviated version. Whatever you upload is committed to git and served to users as-is, and the server rejects the deploy if it detects a stub. When the user attaches or references a file (e.g. an HTML page), read it in full and upload its ENTIRE contents. If a file is genuinely too large to reproduce reliably, stop and tell the user — do not stub or guess it.',
  '',
  'CRITICAL — read before you deploy: fully read and assemble the COMPLETE contents of every file BEFORE calling deploy_app. Do not deploy first and then re-deploy to "fix" or fill in the content — re-deploying the same app fails (the stack already exists) and can leave the placeholder version running. Call deploy_app exactly once per app, with every file already complete.',
  '',
  'Before calling deploy_app, gather and confirm the following with the user. Do not assume defaults silently — ask when anything is unknown or ambiguous:',
  '1. Environment — call list_environments. If more than one is returned, ask which to use.',
  '2. Namespace — call list_namespaces. If more than one is returned, ask which to use.',
  '3. Git target — call list_git_targets. If none exist, tell the user to create one in the Portainer-Run UI (git targets cannot be created via MCP) and stop. If several exist, ask which.',
  '4. App name — propose one and confirm it with the user.',
  '5. Exposure — apps are always exposed at a URL through the cluster ingress controller. Call list_ingress_classes to inform the ingress settings: it reports a baseDomain (when ingressHostRequired is false the host is derived) and the available ingress classes.',
  '6. Ingress (when chosen) — from list_ingress_classes, if ingressHostRequired is true ask the user for the full hostname (otherwise the host is derived as <appName>.<baseDomain>). Confirm which ingress class to use, or let it default to the cluster default.',
  '7. Environment variables / secrets — if the app needs any, list them and ask the user for values.',
  '',
  'Static sites: if the app is plain HTML/CSS/JS with no server-side logic, deploy it as a static site — send only the static files (index.html, css, js, assets) and set runtime to "nginx". Do NOT scaffold a Node/Express (or any) server to serve static files; adding a package.json would make it deploy as a Node app instead of nginx.',
  '',
  'Port: deploy_app has no port parameter. The service port is inferred from the detected runtime (Node 3000, Python 8000, php/nginx 80, Ruby 9292). Make the app listen on that runtime default and bind 0.0.0.0. If the app must use a non-standard port, warn the user that the MCP deploy may expose the wrong port and the app could be unreachable.',
  '',
  'Always show a summary of the chosen settings and get explicit confirmation before calling deploy_app.',
  '',
  'After deploying, report the access URL to the user. The deploy result has a "url" field; if it is null, call get_app_status after a short wait to retrieve the URL.',
].join('\n')

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function buildTools() {
  const tools = []

  tools.push({
    name: 'list_environments',
    description:
      'List available Kubernetes environments in Portainer. Call this first to find the envId needed for deployment.',
    inputSchema: { type: 'object', properties: {} },
  })

  tools.push({
    name: 'list_namespaces',
    description:
      'List Kubernetes namespaces available in a specific environment.',
    inputSchema: {
      type: 'object',
      required: ['envId'],
      properties: {
        envId: {
          type: 'string',
          description: 'Environment ID from list_environments',
        },
      },
    },
  })

  tools.push({
    name: 'list_git_targets',
    description:
      'List git repositories configured in Portainer-Run. These are used to store deployment manifests. Call this to find the gitTargetId needed for deployment.',
    inputSchema: { type: 'object', properties: {} },
  })

  tools.push({
    name: 'list_ingress_classes',
    description:
      'List the IngressClasses defined in a Kubernetes environment, including which one is the cluster default. ' +
      'Call this when deploying to choose the correct ingress class. If you omit ' +
      'ingressClass on deploy_app, the cluster default (if any) is applied automatically. ' +
      'The response also reports baseDomain and ingressHostRequired: when ingressHostRequired is true there is ' +
      'no base domain to derive a hostname from, so you must supply a full ingress.host — ask the user for it.',
    inputSchema: {
      type: 'object',
      required: ['envId'],
      properties: {
        envId: {
          type: 'string',
          description: 'Environment ID from list_environments',
        },
      },
    },
  })

  tools.push({
    name: 'request_upload_session',
    description:
      'Request a staged file upload session from the Portainer-Run gateway. ' +
      'Use this to stage source files before deploying. The AI platform ' +
      'can upload files directly over HTTPS. Returns an uploadUrl the caller POSTs ' +
      'files to as JSON (Array<{ path, content }>), and a sessionId to pass to ' +
      'deploy_app as stagedSessionId. The session is single-use and expires in 5 minutes.',
    inputSchema: { type: 'object', properties: {} },
  })

  tools.push({
    name: 'deploy_app',
    description:
      'Deploy an application to Kubernetes via Portainer-Run. First call request_upload_session ' +
      'and POST the complete source files to the returned uploadUrl, then call this with the ' +
      'stagedSessionId. Runtime detection, dependency installation, git commit, and Kubernetes ' +
      'deployment are all handled automatically. Use list_environments, list_namespaces, and ' +
      'list_git_targets first to get the required IDs.',
    inputSchema: {
      type: 'object',
      required: [
        'appName',
        'envId',
        'namespace',
        'gitTargetId',
        'stagedSessionId',
      ],
      properties: {
        appName: {
          type: 'string',
          description:
            'Application name — lowercase alphanumeric and hyphens only, e.g. my-expense-tracker',
        },
        envId: {
          type: 'string',
          description:
            'Target Kubernetes environment ID (from list_environments)',
        },
        namespace: {
          type: 'string',
          description:
            'Kubernetes namespace to deploy into (from list_namespaces)',
        },
        gitTargetId: {
          type: 'string',
          description:
            'Git target ID for manifest storage (from list_git_targets). Git targets cannot be created via MCP — if none exist, direct the user to add one in the Portainer-Run UI first.',
        },
        runtime: {
          type: 'string',
          enum: ['auto', 'node', 'python', 'php', 'ruby', 'nginx'],
          description:
            'Runtime override. Default: auto (detected from the uploaded files). Set to "nginx" to deploy a static HTML/CSS/JS site — upload only the static files (index.html, css, js, assets) and do NOT scaffold a Node/Express or other server to serve them.',
        },
        stagedSessionId: {
          type: 'string',
          description:
            'Session ID from request_upload_session, after the complete source files have been POSTed to its uploadUrl. This is the only way to supply files.',
        },
        envVars: {
          type: 'array',
          description:
            'Environment variables for the app. Auto-detected from an uploaded .env.example if omitted.',
          items: {
            type: 'object',
            required: ['key', 'value'],
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
        ingress: {
          type: 'object',
          description:
            'Ingress settings. The app is always exposed at a URL through the cluster ingress controller. If host is omitted and a base domain is configured, defaults to <appName>.<baseDomain>.',
          properties: {
            host: {
              type: 'string',
              description:
                'Full ingress hostname, e.g. my-app.example.com. Required unless the server has a base domain configured (check list_ingress_classes — ingressHostRequired). If no base domain is configured, ask the user for the hostname.',
            },
            path: { type: 'string', description: 'Ingress path. Default: /' },
            ingressClass: {
              type: 'string',
              description:
                'Ingress class name, e.g. nginx. Call list_ingress_classes to see options. If omitted, the cluster default IngressClass is applied automatically.',
            },
          },
        },
        branch: {
          type: 'string',
          description: 'Git branch for manifests. Default: main.',
        },
      },
    },
  })

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

/**
 * Reads the set of environments an admin has disabled from deploy flows.
 * Stored as a JSON map (keyed by string env Id, truthy = disabled) in the
 * `portainer-run-config` ConfigMap in CONFIG_NAMESPACE (default: kube-system) — same source as the UI
 * uses. The map is global, so the first environment that returns it wins.
 * Returns {} when no config exists (nothing disabled).
 */
async function fetchDisabledEnvs(target, token, envIds) {
  for (const id of envIds) {
    try {
      const cm = await portainerGet(
        target,
        token,
        `/api/endpoints/${id}/kubernetes/api/v1/namespaces/${CONFIG_NAMESPACE}/configmaps/portainer-run-config`,
      )
      const raw = cm?.data?.disabledEnvs
      if (!raw) continue
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const map = {}
        for (const [k, v] of Object.entries(parsed)) map[String(k)] = v
        return map
      }
    } catch {
      /* unreachable env or no config — try the next */
    }
  }
  return {}
}

async function toolListEnvironments(req) {
  const token = extractToken(req)
  const target = resolvePortainerTarget()
  if (!target)
    throw new Error(
      'Cannot resolve Portainer target — ensure PORTAINER_URL is set on the server',
    )

  const eps = await portainerGet(target, token, '/api/endpoints')
  // Portainer EndpointType: 1=Docker, 2=Agent-on-Docker, 3=Azure, 4=Edge-agent-on-Docker,
  // 5=Kubernetes (local), 6=agent-on-Kubernetes, 7=Edge-on-Kubernetes. This app is
  // Kubernetes-only, so include 5–7 (matches the UI in services/session.js).
  const K8S_TYPES = [5, 6, 7]
  const TYPE_LABELS = { 5: 'local', 6: 'agent', 7: 'edge' }
  const k8sEnvs = (Array.isArray(eps) ? eps : []).filter((e) =>
    K8S_TYPES.includes(e.Type),
  )

  // Hide environments an admin has disabled from deploy flows (matches the UI).
  const disabled = await fetchDisabledEnvs(
    target,
    token,
    k8sEnvs.map((e) => e.Id),
  )
  return k8sEnvs
    .filter((e) => !disabled[String(e.Id)])
    .map((e) => ({
      id: String(e.Id),
      name: e.Name,
      type: TYPE_LABELS[e.Type] || 'kubernetes',
    }))
}

async function toolListNamespaces(req, args) {
  const { envId } = args
  if (!envId) throw new Error('envId is required')
  // Validate envId is numeric to prevent path injection into Portainer API
  if (!/^\d+$/.test(String(envId)))
    throw new Error('envId must be a numeric environment ID')
  const token = extractToken(req)
  const target = resolvePortainerTarget()
  if (!target) throw new Error('Cannot resolve Portainer target')

  // Portainer-native, access-policy-aware endpoint: returns only the namespaces
  // the caller can access. The raw /kubernetes/api/v1/namespaces proxy is NOT
  // filtered by Portainer's access policies and leaks every namespace.
  const data = await portainerGet(
    target,
    token,
    `/api/kubernetes/${envId}/namespaces`,
  )
  const list = Array.isArray(data) ? data : []
  return list
    .filter((n) => !n.IsSystem) // Portainer flags kube-* and portainer as system
    .map((n) => n.Name) // Portainer struct uses capital .Name
    .filter(Boolean)
}

async function toolListGitTargets(req, caller) {
  const conns = getConnectionsForUser(caller.userId)
  const gitTargets = conns.map((c) => ({
    id: c.id,
    name: c.name,
    repo: c.payload?.repo,
    provider: c.payload?.provider,
    defaultBranch: c.payload?.defaultBranch || 'main',
    shared: c.shared,
  }))

  const result = { gitTargets }
  // A git target is required to deploy, and one cannot be created via MCP
  // (that would require a Git credential to transit the chat). Make the
  // dead-end explicit so the model directs the user to the UI instead of
  // failing the deploy.
  if (gitTargets.length === 0) {
    result.message =
      'No git targets are configured for this user. A git target is required to deploy, ' +
      'and it cannot be created through MCP. Ask the user to add one in the Portainer-Run UI ' +
      '(Git Targets section), then call list_git_targets again.'
  }
  return result
}

/**
 * Fetches the IngressClasses defined in an environment via the Portainer
 * Kubernetes proxy (same endpoint used by the Cluster Readiness check).
 * Returns [{ name, controller, isDefault }].
 */
async function fetchIngressClasses(target, token, envId) {
  const data = await portainerGet(
    target,
    token,
    `/api/endpoints/${envId}/kubernetes/apis/networking.k8s.io/v1/ingressclasses`,
  )
  const items = data?.items || []
  return items
    .map((c) => ({
      name: c.metadata?.name,
      controller: c.spec?.controller || '',
      isDefault:
        c.metadata?.annotations?.[
          'ingressclass.kubernetes.io/is-default-class'
        ] === 'true',
    }))
    .filter((c) => c.name)
}

async function toolListIngressClasses(req, args) {
  const { envId } = args
  if (!envId) throw new Error('envId is required')
  // Validate envId is numeric to prevent path injection into Portainer API
  if (!/^\d+$/.test(String(envId)))
    throw new Error('envId must be a numeric environment ID')
  const token = extractToken(req)
  const target = resolvePortainerTarget()
  if (!target) throw new Error('Cannot resolve Portainer target')

  const classes = await fetchIngressClasses(target, token, envId)
  // Tell the model whether a host can be derived server-side. When no base
  // domain is configured, there is nothing to derive — the caller must supply
  // a full ingress.host (and should ask the user for it).
  return {
    classes,
    baseDomain: BASE_DOMAIN || null,
    ingressHostRequired: !BASE_DOMAIN,
  }
}

// ---------------------------------------------------------------------------
// Runtime detection (server-side mirror of client/src/components/VibeDeploy.jsx)
//
// The browser UI fills runtime/runtimeImage/startCmd/workDir/port before calling
// the deploy backend. The MCP path has no UI, so without this it would always
// deploy a bare node:22-slim image with no start command — which crashloops.
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
    image: 'node:22',
    detect: (names) => names.includes('package.json'),
    defaultCmd: (files) => {
      const pkg = files.find((f) => f.name === 'package.json')
      if (pkg) {
        try {
          const parsed = JSON.parse(pkg.text)
          if (parsed?.scripts?.start) return 'npm start'
        } catch {
          /* ignore */
        }
      }
      const hasServerJs = files.some(
        (f) => f.name === 'server.js' || f.name === 'index.js',
      )
      return hasServerJs
        ? `node ${files.find((f) => f.name === 'server.js') ? 'server.js' : 'index.js'}`
        : 'npm start'
    },
    port: 3000,
    workDir: '/app',
  },
  {
    id: 'python',
    image: 'python:3.13-slim',
    detect: (names) =>
      names.includes('requirements.txt') ||
      names.some((n) => n.endsWith('.py')),
    defaultCmd: (files) => {
      for (const candidate of ['main.py', 'app.py', 'server.py', 'run.py']) {
        if (files.some((f) => f.name === candidate))
          return `python ${candidate}`
      }
      return 'python app.py'
    },
    port: 8000,
    workDir: '/app',
  },
  {
    id: 'php',
    image: 'php:8.4-apache',
    detect: (names) => names.some((n) => n.endsWith('.php')),
    defaultCmd: () => 'apache2-foreground',
    port: 80,
    workDir: '/var/www/html',
  },
  {
    id: 'ruby',
    image: 'ruby:3.4-slim',
    detect: (names) =>
      names.includes('Gemfile') || names.some((n) => n.endsWith('.rb')),
    defaultCmd: (files) => {
      for (const candidate of ['app.rb', 'server.rb', 'config.ru']) {
        if (files.some((f) => f.name === candidate)) {
          return candidate === 'config.ru'
            ? 'bundle exec rackup -p 9292 -o 0.0.0.0'
            : `ruby ${candidate}`
        }
      }
      return 'bundle exec ruby app.rb'
    },
    port: 9292,
    workDir: '/app',
  },
]

const ALL_RUNTIMES = [...RUNTIMES, NGINX_RUNTIME]

/**
 * Resolves the runtime for a list of MCP files ({ path, content }).
 * When `forcedId` is given (and not 'auto') that runtime is used directly —
 * e.g. 'nginx' to serve a static site even if a stray package.json is present.
 * Otherwise the runtime is detected from the file structure.
 * Returns { id, image, startCmd, workDir, port }.
 */
function detectRuntimeForFiles(files, forcedId) {
  // Map MCP { path, content } → { name, text } used by the detection table.
  const mapped = files.map((f) => ({
    name: (f.path || '').split('/').pop(),
    text: f.content,
  }))
  const names = mapped.map((f) => f.name)

  let rt
  if (forcedId && forcedId !== 'auto') {
    rt = ALL_RUNTIMES.find((r) => r.id === forcedId)
    if (!rt)
      throw new Error(
        `Unknown runtime "${forcedId}" — use one of: ${ALL_RUNTIMES.map((r) => r.id).join(', ')}`,
      )
  } else {
    // Static sites (all assets static) and the no-match case both default to nginx.
    rt = RUNTIMES.find((r) => r.detect(names)) || NGINX_RUNTIME
  }

  return {
    id: rt.id,
    image: rt.image,
    startCmd: rt.defaultCmd(mapped),
    workDir: rt.workDir,
    port: rt.port,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pickNodeIp(nodes) {
  for (const node of nodes || []) {
    const addrs = node.status?.addresses || []
    const ip =
      addrs.find((a) => a.type === 'ExternalIP')?.address ||
      addrs.find((a) => a.type === 'InternalIP')?.address
    if (ip) return ip
  }
  return null
}

/**
 * Builds the externally-reachable URL for a freshly deployed app, reusing the
 * same resolveUrl logic as the live status endpoint. Ingress hosts are known
 * up front; NodePort/LoadBalancer addresses are assigned asynchronously, so
 * this polls briefly. Returns { url, label, type } or null. Best-effort —
 * never throws.
 */
async function resolveAppAccessUrl(
  target,
  token,
  envId,
  ns,
  appName,
  { attempts = 1, delayMs = 0 } = {},
) {
  const base = `/api/endpoints/${envId}/kubernetes`
  let last = null
  for (let i = 0; i < attempts; i++) {
    try {
      const [svc, ing, nodesData] = await Promise.all([
        portainerGet(
          target,
          token,
          `${base}/api/v1/namespaces/${ns}/services/${appName}`,
        ).catch(() => null),
        portainerGet(
          target,
          token,
          `${base}/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${appName}`,
        ).catch(() => null),
        portainerGet(target, token, `${base}/api/v1/nodes`).catch(() => null),
      ])
      const svcs = svc?.kind === 'Service' ? [svc] : []
      const ings = ing?.kind === 'Ingress' ? [ing] : []
      // Fall back to the Portainer host when node IPs aren't listable (403) —
      // gives a usable NodePort URL on single-node/internal clusters.
      const nodeIp =
        pickNodeIp(nodesData?.items) || (svcs.length ? target.host : null)
      last = resolveUrl(appName, svcs, ings, nodeIp)
      if (last?.url) return last
    } catch {
      /* best effort */
    }
    if (i < attempts - 1) await sleep(delayMs)
  }
  return last
}

// Markers that strongly indicate a placeholder or truncated file rather than
// real content. Deliberately phrase- and comment-based so legitimate uses of
// "..." (spread/rest, e.g. `const { a, ...rest } = x`) and short-but-real files
// are not flagged.
const PLACEHOLDER_MARKERS = [
  {
    re: /\brest of (the )?(file|code|content|implementation|component|markup|styles?|script|document)\b/i,
    reason: 'a "rest of the file" note',
  },
  {
    re: /\b(your|the|actual|full|real|original|complete) (code|content|file|markup|implementation) (here|goes here|belongs here|below|above)\b/i,
    reason: 'a "content goes here" note',
  },
  {
    re: /\b(content|code|file|markup|output|section|html|body) (omitted|truncated|snipped|abbreviated|redacted|shortened)\b/i,
    reason: 'an "omitted/truncated" note',
  },
  {
    re: /(\/\/|#|<!--|\/\*)\s*\.\.\.\s*(rest|remainder|more|omitted|truncat|unchanged|same|continue|abbreviat|snip)/i,
    reason: 'a comment ellipsis placeholder',
  },
  {
    re: /\[\s*(omitted|truncated|placeholder|snip|redacted)\s*\]/i,
    reason: 'a bracketed placeholder',
  },
  {
    re: /\bplaceholder (file|content)\b/i,
    reason: 'a "placeholder content" note',
  },
  {
    re: /\bpaste (the )?(full|real|actual|original|complete|entire) (file|content|code|contents)\b/i,
    reason: 'a "paste the full file" note',
  },
  {
    re: /\bTODO:\s*(paste|insert|fill in|add the|replace with)/i,
    reason: 'a TODO to fill in content',
  },
]

// Scan uploaded files for obvious stub/placeholder content. Returns the first
// offending { path, reason } or null. Conservative by design — a false negative
// is preferable to rejecting a legitimate file.
function detectPlaceholderContent(files) {
  for (const f of files) {
    const content = typeof f?.content === 'string' ? f.content : ''
    if (!content) continue
    for (const m of PLACEHOLDER_MARKERS) {
      if (m.re.test(content))
        return { path: f?.path || '(unknown)', reason: m.reason }
    }
  }
  return null
}

async function toolRequestUploadSession() {
  return requestUploadSession()
}

async function toolDeployVibeApp(req, args, caller) {
  const {
    appName,
    envId,
    namespace,
    gitTargetId,
    envVars,
    ingress = {},
    branch = 'main',
    runtime = 'auto',
    stagedSessionId,
  } = args

  if (!appName || !envId || !namespace || !gitTargetId) {
    throw new Error(
      'appName, envId, namespace, and gitTargetId are all required',
    )
  }
  if (!/^\d+$/.test(String(envId))) {
    throw new Error(
      'envId must be the numeric environment ID from list_environments',
    )
  }
  if (!stagedSessionId) {
    throw new Error(
      'stagedSessionId is required. Call request_upload_session, POST the complete files to its uploadUrl, then call deploy_app with the returned sessionId.',
    )
  }

  // All files arrive via the gateway upload session — there is no inline path.
  const files = await fetchStagedFiles(stagedSessionId)
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      'No files found for this upload session. Start a new session with request_upload_session, upload the files, then retry.',
    )
  }

  // Reject obvious placeholder / truncated content before it reaches git. This
  // catches a model that uploaded a stub instead of the real file.
  const stub = detectPlaceholderContent(files)
  if (stub) {
    throw new Error(
      `Upload rejected: "${stub.path}" looks like a placeholder or truncated file (found ${stub.reason}). ` +
        'Upload the complete, unmodified contents of every file via a new upload session, then retry.',
    )
  }

  // Apps are always exposed at a URL through the cluster ingress controller.
  const exposeType = 'Ingress'

  const safeAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  // Resolve ingress settings. Without an explicit host, fall back to
  // <appName>.<BASE_DOMAIN> if a base domain is configured — mirroring the
  // template/UI default.
  const resolvedIngress = {
    host: ingress.host || (BASE_DOMAIN ? `${safeAppName}.${BASE_DOMAIN}` : ''),
    path: ingress.path || '/',
    ...(ingress.ingressClass ? { ingressClass: ingress.ingressClass } : {}),
  }

  if (!resolvedIngress.host) {
    throw new Error(
      'An ingress host is required (provide ingress.host or configure BASE_DOMAIN)',
    )
  }

  // When no class was supplied, pick an IngressClass so the Ingress is actually
  // claimed by a controller: prefer the cluster default, else use the only class
  // if there is exactly one (the common single-controller, e.g. nginx, case).
  // Best effort — if the lookup fails or it's ambiguous, deploy without a class.
  if (!resolvedIngress.ingressClass) {
    try {
      const target = resolvePortainerTarget()
      if (target) {
        const classes = await fetchIngressClasses(
          target,
          extractToken(req),
          envId,
        )
        const chosen =
          classes.find((c) => c.isDefault) ||
          (classes.length === 1 ? classes[0] : null)
        if (chosen) resolvedIngress.ingressClass = chosen.name
      }
    } catch {
      /* no class resolvable — continue without one */
    }
  }

  // Detect runtime, image, start command, working dir, and port from the files —
  // the UI does this client-side; without it the MCP deploy crashloops. A
  // caller-supplied runtime (e.g. "nginx" for a static site) overrides detection.
  const detected = detectRuntimeForFiles(files, runtime)

  // Auto-detect env vars from .env.example if not provided
  let resolvedEnvVars = envVars
  if (!resolvedEnvVars) {
    const envExample = files.find(
      (f) => f.path === '.env.example' || f.path.endsWith('/.env.example'),
    )
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

  // Resolve the environment name so committed git paths match the UI, which
  // writes under the environment NAME rather than the numeric ID. Falls back
  // to the ID-based path (handled downstream) if the lookup is unavailable.
  let resolvedEnvName = ''
  try {
    const target = resolvePortainerTarget()
    if (target) {
      const ep = await portainerGet(target, token, `/api/endpoints/${envId}`)
      if (ep && ep.Name) resolvedEnvName = ep.Name
    }
  } catch {
    /* fall back to envId-based path */
  }

  const mockBodyBuf = Buffer.from(
    JSON.stringify({
      gitTargetId,
      branch,
      pathPrefix: '',
      pollInterval: '5m',
      envId,
      envName: resolvedEnvName,
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
    }),
  )

  const mockReq = {
    method: 'POST',
    url: '/api/vibe/deploy',
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
    },
    on(event, handler) {
      if (event === 'data') process.nextTick(() => handler(mockBodyBuf))
      if (event === 'end') process.nextTick(() => handler())
      if (event === 'error') {
        /* no-op */
      }
      return this
    },
  }

  let result = null
  await new Promise((resolve, reject) => {
    const mockRes = {
      statusCode: 200,
      writeHead(code) {
        this.statusCode = code
      },
      end(body) {
        this._body = body || ''
        resolve(this)
      },
    }
    handleVibe(mockReq, mockRes, '/api/vibe/deploy').catch(reject)
  }).then((r) => {
    result = r
  })

  if (result.statusCode >= 400) {
    let errMsg = 'Deploy failed'
    try {
      errMsg = JSON.parse(result._body)?.error || errMsg
    } catch {
      /* ignore */
    }
    throw new Error(errMsg)
  }

  let data = {}
  try {
    data = JSON.parse(result._body)
  } catch {
    /* ignore */
  }
  const deployedName = data.appName || safeAppName

  // Resolve an access URL for the response. Ingress hosts are known immediately.
  let access = null
  try {
    if (resolvedIngress.host) {
      const p =
        resolvedIngress.path && resolvedIngress.path !== '/'
          ? resolvedIngress.path
          : ''
      access = {
        url: `http://${resolvedIngress.host}${p}`,
        label: resolvedIngress.host,
        type: 'ingress',
      }
    }
  } catch {
    /* best effort — URL is a convenience */
  }

  let message = `${deployedName} deployed to ${namespace} successfully.`
  if (access?.url) {
    message += ` Access it at ${access.url}`
    if (access.type === 'ingress')
      message +=
        ' (ensure DNS for the host points to your ingress controller; served over HTTP unless TLS is configured)'
  } else {
    message +=
      ' The URL is still being assigned — call get_app_status shortly, or check the Applications page, for the URL.'
  }

  return {
    ok: true,
    appName: deployedName,
    namespace,
    envId,
    exposeType,
    url: access?.url || null,
    accessLabel: access?.label || null,
    message,
  }
}

async function toolGetAppStatus(req, args) {
  const { appName, envId, namespace } = args
  if (!appName || !envId || !namespace) {
    throw new Error('appName, envId, and namespace are all required')
  }
  if (!/^\d+$/.test(String(envId))) {
    throw new Error(
      'envId must be the numeric environment ID from list_environments',
    )
  }
  const token = extractToken(req)
  const target = resolvePortainerTarget()
  if (!target) {
    return {
      found: false,
      message: 'Could not resolve the Portainer target for this request.',
    }
  }

  // Ask the cluster directly for the Deployment rather than trusting the
  // browser-populated cache, which a headless MCP workflow never fills. A short
  // retry covers the brief window where Portainer is still reconciling the
  // freshly committed GitOps stack.
  const depPath = `/api/endpoints/${envId}/kubernetes/apis/apps/v1/namespaces/${namespace}/deployments/${appName}`
  let dep = null
  for (let i = 0; i < 4; i++) {
    dep = await portainerGet(target, token, depPath).catch(() => null)
    if (dep && dep.kind === 'Deployment') break
    dep = null
    if (i < 3) await sleep(1500)
  }

  if (!dep) {
    return {
      found: false,
      message: `No application found for ${appName} in ${namespace}`,
    }
  }

  const desired = dep.spec?.replicas ?? 1
  const ready = dep.status?.readyReplicas || 0
  const available = dep.status?.availableReplicas || 0
  const unavailableCond = (dep.status?.conditions || []).find(
    (c) => c.type === 'Available' && c.status === 'False',
  )
  const status =
    desired === 0
      ? 'stopped'
      : ready >= desired && available >= desired
        ? 'running'
        : ready > 0
          ? 'partial'
          : unavailableCond
            ? 'error'
            : 'pending'
  const container = dep.spec?.template?.spec?.containers?.[0]

  // Resolve a live access URL (Service/Ingress may still be settling).
  let access = null
  try {
    access = await resolveAppAccessUrl(target, token, envId, namespace, appName)
  } catch {
    /* best effort */
  }

  return {
    found: true,
    appName,
    namespace,
    status,
    ready,
    desired,
    image: container?.image || null,
    reason: unavailableCond?.message || null,
    url: access?.url || null,
    accessLabel: access?.label || null,
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
        instructions: SERVER_INSTRUCTIONS,
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
        case 'list_ingress_classes':
          toolResult = await toolListIngressClasses(req, args)
          break
        case 'request_upload_session':
          toolResult = await toolRequestUploadSession()
          break
        case 'deploy_app':
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
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message:
            'Unauthorized — provide a Portainer API token via Authorization: Bearer <token> or X-API-Key header',
        },
      }),
    )
    return
  }

  const body = await readBody(req)
  let rpc
  try {
    rpc = JSON.parse(body.toString('utf8'))
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }),
    )
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
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: isRpcError
          ? err
          : { code: -32603, message: err?.message || 'Internal error' },
      }),
    )
  }
}
