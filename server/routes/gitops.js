import { readBody } from '../lib/http.js'
import { CORS } from '../lib/cors.js'
import { getConnectionById } from '../models/connection.js'
import { resolveCallerIdentity, extractToken } from '../lib/identity.js'
import { commitFiles, ensureBranch, buildRepoHttpsUrl, deleteFile, deleteDirectory, fetchFile } from '../proxy/git.js'
import { buildManifests, serializeManifests, buildManifestPath } from '../lib/manifestSerialize.js'
import { serializeManifestBuilder } from '../lib/manifestBuilderSerialize.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'
import https from 'node:https'
import http from 'node:http'

/**
 * Handle all /api/gitops/* routes.
 *
 * POST /api/gitops/deploy
 *   Body: { gitTargetId, branch, pathPrefix?, pollInterval?, deployParams, envId }
 *
 * POST /api/gitops/update
 *   Body: { gitTargetId, branch, gitPath, deployParams }
 *   Commits updated manifest only — Portainer reconciles automatically.
 *
 * POST /api/gitops/validate
 *   Body: { deployParams, envId }
 *   Dry-run validates manifests against the Kubernetes API without committing anything.
 */
export async function handleGitOps(req, res, pathname) {
  // Require a Portainer API token on all GitOps routes
  if (!extractToken(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return true
  }

  if (pathname === '/api/gitops/deploy' && req.method === 'POST') {
    return handleDeploy(req, res)
  }
  if (pathname === '/api/gitops/update' && req.method === 'POST') {
    return handleUpdate(req, res)
  }
  if (pathname === '/api/gitops/validate' && req.method === 'POST') {
    return handleValidate(req, res)
  }
  if (pathname === '/api/gitops/manifest' && req.method === 'POST') {
    return handleDeleteManifest(req, res)
  }
  if (pathname === '/api/gitops/manifest' && req.method === 'GET') {
    return handleFetchManifest(req, res)
  }
  return null
}

// --- sanitize stack name to Portainer-safe format ---
function sanitizeStackName(name) {
  return name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

// --- sanitize git path to prevent path traversal ---
function sanitizeGitPath(p) {
  if (!p || typeof p !== 'string') return ''
  return p
    .split('/')
    .map((seg) => seg.replace(/\.\./g, '').trim())
    .filter(Boolean)
    .join('/')
}

// --- whitelist poll interval values ---
const VALID_POLL_INTERVALS = new Set(['5m', '15m', '30m', '1h', '24h'])
function sanitizePollInterval(v) {
  return VALID_POLL_INTERVALS.has(v) ? v : '5m'
}

async function handleDeploy(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { gitTargetId, branch, pathPrefix, pollInterval, deployParams, manifestBuilderParams, envId } = data
  if (!gitTargetId || !branch || (!deployParams && !manifestBuilderParams) || !envId) {
    return json(res, 400, { error: 'gitTargetId, branch, deployParams or manifestBuilderParams, and envId are required' })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })
  const goCallerD = await resolveCallerIdentity(req)
  if (!goCallerD?.isAdmin && conn.owner_id !== (goCallerD?.userId || '_unknown') && !conn.shared) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }
  const goCallerC = await resolveCallerIdentity(req)
  if (!goCallerC?.isAdmin && conn.owner_id !== (goCallerC?.userId || '_unknown') && !conn.shared) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }
  const goCallerB = await resolveCallerIdentity(req)
  if (!goCallerB?.isAdmin && conn.owner_id !== (goCallerB?.userId || '_unknown') && !conn.shared) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }
  const goCallerA = await resolveCallerIdentity(req)
  if (!goCallerA?.isAdmin && conn.owner_id !== (goCallerA?.userId || '_unknown') && !conn.shared) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }

  // Determine which deploy path to use
  const isManifestBuilder = Boolean(manifestBuilderParams)
  const appName = isManifestBuilder ? manifestBuilderParams.appName : deployParams.appName
  const ns = isManifestBuilder ? manifestBuilderParams.namespace : deployParams.ns
  const gitPath = sanitizeGitPath(buildManifestPath({ pathPrefix: sanitizeGitPath(pathPrefix || conn.payload.pathPrefix || ''), ns, appName }))

  try {
    // 1. Ensure branch exists
    await ensureBranch(conn.payload, branch)

    // 2. Build manifests with GitOps annotations
    let yamlContent
    if (isManifestBuilder) {
      yamlContent = serializeManifestBuilder(manifestBuilderParams, { gitTargetId, gitBranch: branch, gitPath })
    } else {
      const manifests = buildManifests({
        ...deployParams,
        gitopsAnnotations: { gitTargetId, gitBranch: branch, gitPath },
      })
      yamlContent = serializeManifests(manifests)
    }

    // 4. Commit to Git
    const commitResult = await commitFiles(
      conn.payload,
      branch,
      `deploy: ${appName} to ${ns}`,
      [{ path: gitPath, content: yamlContent }],
    )

    // 5. Create Portainer GitOps stack
    const repoUrl = buildRepoHttpsUrl(conn.payload)
    const interval = sanitizePollInterval(pollInterval)
    const stackResult = await createPortainerGitOpsStack(req, {
      envId,
      appName,
      ns,
      repoUrl,
      branch,
      filePath: gitPath,
      username: conn.payload.username || '',
      token: conn.payload.token || '',
      authType: conn.payload.authType || 'pat',
      pollInterval: interval,
    })

    // 6. Patch stack-id annotation back onto the Deployment.
    // Kubernetes stacks return { Output: '' } not { Id: N } — handle both.
    const stackId = stackResult?.Id != null
      ? String(stackResult.Id)
      : stackResult?.Output != null
        ? 'created'
        : null

    if (stackId) {
      await patchDeploymentStackAnnotation(req, { envId, ns, appName, stackId })
    }

    return json(res, 200, {
      ok: true,
      sha: commitResult.sha,
      gitPath,
      stackId,
    })
  } catch (err) {
    console.error('[gitops deploy error]', err.message)
    return json(res, 502, { error: err.message })
  }
}

async function handleUpdate(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { gitTargetId, branch, deployParams } = data
  const gitPath = sanitizeGitPath(data.gitPath)
  if (!gitTargetId || !branch || !gitPath || !deployParams) {
    return json(res, 400, { error: 'gitTargetId, branch, gitPath and deployParams are required' })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })

  const { appName } = deployParams

  try {
    // If client serialized the YAML directly (MB edit path), use it as-is
    let yamlContent
    if (deployParams._yamlOverride) {
      yamlContent = deployParams._yamlOverride
    } else {
      const manifests = buildManifests({
        ...deployParams,
        gitopsAnnotations: { gitTargetId, gitBranch: branch, gitPath },
      })
      yamlContent = serializeManifests(manifests)
    }

    const commitResult = await commitFiles(
      conn.payload,
      branch,
      `update: ${appName}`,
      [{ path: gitPath, content: yamlContent }],
    )

    return json(res, 200, { ok: true, sha: commitResult.sha })
  } catch (err) {
    console.error('[gitops update error]', err.message)
    return json(res, 502, { error: err.message })
  }
}

/**
 * Dry-run: validates manifests against the Kubernetes API without committing.
 * Uses ?dryRun=All&fieldManager=portainer-run on each resource.
 * Returns per-resource pass/warn/fail results.
 */
async function handleValidate(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { deployParams, manifestBuilderParams, envId } = data
  if ((!deployParams && !manifestBuilderParams) || !envId) {
    return json(res, 400, { error: 'deployParams or manifestBuilderParams, and envId are required' })
  }

  const target = resolvePortainerTarget(req)
  if (!target) return json(res, 400, { error: 'Cannot resolve Portainer target' })

  const userToken = extractToken(req)

  // Build manifests using the correct serializer for the param shape
  let manifests = []
  let appName, ns

  if (manifestBuilderParams) {
    appName = manifestBuilderParams.appName
    ns = manifestBuilderParams.namespace
    const yaml = serializeManifestBuilder(manifestBuilderParams, { gitTargetId: 'dry-run', gitBranch: 'dry-run', gitPath: 'dry-run' })
    // Re-parse the YAML back to objects for validation
    const jsYaml = await import('js-yaml')
    manifests = jsYaml.loadAll(yaml).filter(Boolean)
  } else {
    appName = deployParams.appName
    ns = deployParams.ns
    manifests = buildManifests({
      ...deployParams,
      gitopsAnnotations: { gitTargetId: 'dry-run', gitBranch: 'dry-run', gitPath: 'dry-run' },
    }).filter(Boolean)
  }

  const results = []

  for (const manifest of manifests) {
    const { apiVersion, kind, metadata } = manifest
    if (!apiVersion || !kind) {
      results.push({ kind: 'unknown', name: metadata?.name || '?', status: 'warn', message: 'Skipped — not a Kubernetes resource' })
      continue
    }

    const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion]
    const apiBase = group
      ? `endpoints/${envId}/kubernetes/apis/${group}/${version}`
      : `endpoints/${envId}/kubernetes/api/${version}`

    const kindPlural = kindToPlural(kind)
    const resourceNs = metadata?.namespace || ns
    const apiPath = `/api/${apiBase}/namespaces/${resourceNs}/${kindPlural}?dryRun=All&fieldManager=portainer-run`

    try {
      await portainerRequest(target, userToken, 'POST', apiPath, JSON.stringify(manifest))
      results.push({ kind, name: metadata?.name || '?', status: 'pass', message: `${kind} passed server-side validation` })
    } catch (err) {
      results.push({ kind, name: metadata?.name || '?', status: 'fail', message: err.message })
    }
  }

  return json(res, 200, { ok: true, results })
}


async function handleDeleteManifest(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { gitTargetId, branch, appName } = data
  const gitPath = sanitizeGitPath(data.gitPath)
  if (!gitTargetId || !branch || !gitPath) {
    return json(res, 400, { error: 'gitTargetId, branch and gitPath are required' })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })

  try {
    // Paths ending without an extension are treated as directories (vibe source paths)
    // Paths ending with .yaml/.yml are manifest files
    const isDirectory = !gitPath.match(/\.[a-zA-Z0-9]+$/)
    if (isDirectory) {
      await deleteDirectory(conn.payload, branch, gitPath, `remove: ${appName || gitPath}`)
    } else {
      await deleteFile(conn.payload, branch, gitPath, `remove: ${appName || gitPath}`)
    }
    return json(res, 200, { ok: true })
  } catch (err) {
    console.error('[gitops delete manifest error]', err.message)
    return json(res, 502, { error: err.message })
  }
}

async function handleFetchManifest(req, res) {
  const url = new URL(req.url, 'https://localhost')
  const gitTargetId = sanitizeGitPath(url.searchParams.get('gitTargetId') || '')
  const branch = url.searchParams.get('branch') || ''
  const gitPath = sanitizeGitPath(url.searchParams.get('path') || '')

  if (!gitTargetId || !branch || !gitPath) {
    return json(res, 400, { error: 'gitTargetId, branch and path are required' })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })

  try {
    const content = await fetchFile(conn.payload, branch, gitPath)
    return json(res, 200, { content })
  } catch (err) {
    return json(res, 502, { error: err.message })
  }
}

// --- Portainer API helpers ---

/**
 * Create a Kubernetes GitOps stack in Portainer.
 * Body shape matches the working implementation from openshift-migrator.
 */
async function createPortainerGitOpsStack(req, {
  envId, appName, ns, repoUrl, branch, filePath,
  username, token, authType, pollInterval,
}) {
  const target = resolvePortainerTarget(req)
  if (!target) throw new Error('Cannot resolve Portainer target — check PORTAINER_URL or X-Portainer-URL header')

  const userToken = extractToken(req)

  const stackBody = {
    StackName: sanitizeStackName(appName),
    RepositoryURL: repoUrl,
    RepositoryReferenceName: `refs/heads/${branch}`,
    ManifestFile: filePath,
    Namespace: ns,
    ComposeFormat: false,
    TLSSkipVerify: true,
    AutoUpdate: {
      Interval: pollInterval || '5m',
      ForceUpdate: false,
      ForcePullImage: false,
    },
    ...(authType === 'pat' && token ? {
      RepositoryAuthentication: true,
      RepositoryAuthorizationType: 0,
      RepositoryUsername: username || 'oauth2',
      RepositoryPassword: token,
    } : {
      RepositoryAuthentication: false,
    }),
  }

  const body = JSON.stringify(stackBody)
  return portainerRequest(
    target,
    userToken,
    'POST',
    `/api/stacks/create/kubernetes/repository?endpointId=${envId}`,
    body,
  )
}

/**
 * Patch the portainer-run/stack-id annotation onto the live Deployment.
 * Best-effort — failure is logged but not fatal.
 */
async function patchDeploymentStackAnnotation(req, { envId, ns, appName, stackId }) {
  const target = resolvePortainerTarget(req)
  if (!target) return

  const userToken = extractToken(req)
  const patch = JSON.stringify({
    metadata: { annotations: { 'portainer-run/stack-id': stackId } },
  })

  try {
    await portainerRequest(
      target,
      userToken,
      'PATCH',
      `/api/endpoints/${envId}/kubernetes/apis/apps/v1/namespaces/${ns}/deployments/${appName}`,
      patch,
      'application/strategic-merge-patch+json',
    )
  } catch (err) {
    console.warn('[gitops] Failed to patch stack-id annotation:', err.message)
  }
}

function portainerRequest(target, userToken, method, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const transport = target.isHttps ? https : http
    const headers = { 'Content-Type': contentType, Accept: 'application/json' }
    if (userToken) headers['Cookie'] = `portainer_api_key=${userToken}`
    if (body) headers['Content-Length'] = Buffer.byteLength(body)

    const opts = {
      hostname: target.host,
      port: target.port,
      path,
      method,
      headers,
      rejectUnauthorized: false,
    }

    const reqOut = transport.request(opts, (upRes) => {
      const chunks = []
      upRes.on('data', (c) => chunks.push(c))
      upRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (upRes.statusCode >= 400) {
          let msg = `Portainer API HTTP ${upRes.statusCode}`
          try { msg = JSON.parse(text)?.message || msg } catch { /* ignore */ }
          return reject(new Error(msg))
        }
        try { resolve(JSON.parse(text)) } catch { resolve(text) }
      })
    })

    reqOut.on('error', reject)
    if (body) reqOut.write(body)
    reqOut.end()
  })
}

// Kind → plural mapping matching the migrator
function kindToPlural(kind) {
  const map = {
    Deployment: 'deployments', Service: 'services', ConfigMap: 'configmaps',
    Secret: 'secrets', Ingress: 'ingresses', PersistentVolumeClaim: 'persistentvolumeclaims',
    PersistentVolume: 'persistentvolumes', ServiceAccount: 'serviceaccounts',
    NetworkPolicy: 'networkpolicies', Job: 'jobs', CronJob: 'cronjobs',
    StatefulSet: 'statefulsets', DaemonSet: 'daemonsets',
  }
  return map[kind] || kind.toLowerCase() + 's'
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

function parseJson(body) {
  if (!body || !body.length) return null
  try { return JSON.parse(body.toString('utf8')) } catch { return null }
}
