import { readBody } from '../lib/http.js'
import { CORS } from '../lib/cors.js'
import { getConnectionById } from '../models/connection.js'
import {
  commitFiles,
  ensureBranch,
  buildRepoHttpsUrl,
  fetchFile,
} from '../proxy/git.js'
import { buildManifests, serializeManifests, buildManifestPath } from '../lib/manifestSerialize.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'
import https from 'node:https'
import http from 'node:http'

/**
 * Handle all /api/vibe/* routes.
 *
 * POST /api/vibe/deploy
 *   Body: {
 *     gitTargetId, branch, pathPrefix?, pollInterval?,
 *     envId,
 *     deployParams: { appName, ns, instances, containerSpecs, containerRowIds,
 *                     volumeDefs, exposeType, servicePorts, ingress },
 *     vibeParams: { runtime, runtimeImage, startCmd, workDir, envVars, sourceFiles }
 *   }
 *
 * Flow:
 *   1. Validate inputs
 *   2. Ensure git branch exists
 *   3. Commit all source files to git at pathPrefix/ns/appName/src/
 *   4. Build and commit Kubernetes manifests (Deployment + PVC + Service/Ingress)
 *      The Deployment uses an init container (alpine/git) to sync source into the PV,
 *      plus a .env file written from vibeParams.envVars.
 *   5. Create Portainer GitOps stack
 */
export async function handleVibe(req, res, pathname) {
  // Require a Portainer API token on all vibe routes
  if (!req.headers['x-api-key']) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return true
  }

  if (pathname === '/api/vibe/deploy' && req.method === 'POST') {
    return handleVibeDeploy(req, res)
  }

  if (pathname === '/api/vibe/update' && req.method === 'POST') {
    return handleVibeUpdate(req, res)
  }

  if (pathname === '/api/vibe/update-exposure' && req.method === 'POST') {
    return handleVibeUpdateExposure(req, res)
  }

  if (pathname === '/api/vibe/manifest-exposure' && req.method === 'GET') {
    return handleVibeManifestExposure(req, res)
  }

  return null
}

// --- sanitize helpers (mirrors gitops.js) ---
function sanitizeStackName(name) {
  return name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

function sanitizeGitPath(p) {
  if (!p || typeof p !== 'string') return ''
  return p
    .split('/')
    .map((seg) => seg.replace(/\.\./g, '').trim())
    .filter(Boolean)
    .join('/')
}

const VALID_POLL_INTERVALS = new Set(['5m', '15m', '30m', '1h', '24h'])
function sanitizePollInterval(v) {
  return VALID_POLL_INTERVALS.has(v) ? v : '5m'
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
  return true
}

function parseJson(buf) {
  if (!buf) return null
  try { return JSON.parse(buf.toString('utf8')) } catch { return null }
}

// ---------------------------------------------------------------------------
// Runtime install commands
// ---------------------------------------------------------------------------

/**
 * Returns the shell command to install dependencies for a given runtime,
 * or null if no install step is needed (e.g. nginx static sites).
 *
 * Runs inside the runtime image so native modules compile correctly.
 *
 * @param {string} runtime  e.g. 'node', 'python', 'ruby', 'php', 'nginx'
 * @param {string} workDir  absolute path inside the container
 * @returns {string|null}
 */
function getInstallCommand(runtime, workDir) {
  switch (runtime) {
    case 'node':
      return `cd ${workDir} && if [ -f package.json ]; then npm install --production --prefer-offline 2>&1 || npm install --production 2>&1; fi`
    case 'python':
      return `cd ${workDir} && if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi`
    case 'ruby':
      return `cd ${workDir} && if [ -f Gemfile ]; then bundle install --without development test; fi`
    case 'php':
      return `cd ${workDir} && if [ -f composer.json ] && command -v composer > /dev/null 2>&1; then composer install --no-dev --optimize-autoloader --no-interaction; fi`
    case 'nginx':
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Build the Vibe Deploy Kubernetes manifest set
// ---------------------------------------------------------------------------

/**
 * Builds the Kubernetes manifests for a Vibe Deploy app.
 *
 * Resources generated:
 *  - PersistentVolumeClaim  (app data + source PV)
 *  - Deployment             (init container syncs source from git; main container runs app)
 *  - Service                (ClusterIP or NodePort)
 *  - Ingress                (optional)
 *
 * @param {object} p
 * @param {string} p.appName
 * @param {string} p.ns
 * @param {number} p.instances
 * @param {object} p.vibeParams  { runtime, runtimeImage, startCmd, workDir, envVars }
 * @param {'none'|'NodePort'|'Ingress'} p.exposeType
 * @param {number[]} p.servicePorts
 * @param {{ host?, path?, port?, ingressClass? }} p.ingress
 * @param {object} p.gitopsAnnotations  { gitTargetId, gitBranch, gitPath }
 * @param {string} p.gitRepoUrl
 * @param {string} p.gitBranch
 * @param {string} p.gitSourcePath  path inside repo where source files were committed
 * @param {string} p.gitUsername
 * @param {string} p.gitToken
 */
function buildVibeManifests({
  appName,
  ns,
  instances,
  vibeParams,
  exposeType,
  servicePorts,
  ingress,
  gitopsAnnotations,
  gitRepoUrl,
  gitBranch,
  gitSourcePath,
  gitUsername,
  gitToken,
}) {
  const { runtime, runtimeImage, startCmd, workDir, envVars } = vibeParams
  const safeApp = sanitizeStackName(appName)
  const port = servicePorts?.[0] || 80
  const workDirSafe = workDir || '/app'

  const labels = {
    app: safeApp,
    'managed-by': 'portainer-run',
  }

  // For git source deployments, there are no source files in the manifests repo
  // to clean up on delete — so the source path annotation is omitted.
  const annotations = {
    'portainer-run/deploy-type':      'vibe',
    'portainer-run/git-target-id':    gitopsAnnotations.gitTargetId,
    'portainer-run/git-branch':       gitopsAnnotations.gitBranch,
    'portainer-run/git-path':         gitopsAnnotations.gitPath,
    ...(gitSourcePath ? { 'portainer-run/vibe-source-path': gitSourcePath } : {}),
  }

  // PVC
  const pvc = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: `${safeApp}-data`, namespace: ns, labels, annotations },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '1Gi' } },
    },
  }

  // Build env array for the main container
  const containerEnv = (envVars || [])
    .filter((v) => v.key)
    .map((v) => ({ name: v.key, value: v.value }))

  // Init container: clones/syncs source from git into the PV
  // Two init containers: first clones and copies source; second writes .env if needed.
  const initContainers = []

  // Init 1: clone source and copy files into PV.
  // Git credentials are passed via env vars from a Secret — never embedded in the command.
  const secretName = `${safeApp}-git-credentials`
  const cloneUrl = gitToken
    ? `https://${gitRepoUrl.replace(/^https?:\/\//, '')}`
    : gitRepoUrl
  const cloneCmd = [
    'sh', '-c',
    [
      'git config --global http.sslVerify false',
      gitToken
        ? `git clone --depth 1 --branch ${gitBranch} https://${'${GIT_USERNAME}'}:${'${GIT_TOKEN}'}@${gitRepoUrl.replace(/^https?:\/\//, '')} /tmp/repo`
        : `git clone --depth 1 --branch ${gitBranch} ${gitRepoUrl} /tmp/repo`,
      `mkdir -p ${workDirSafe}`,
      gitSourcePath
        ? `cp -r /tmp/repo/${gitSourcePath}/. ${workDirSafe}/`
        : `cp -r /tmp/repo/. ${workDirSafe}/`,
      `rm -rf /tmp/repo`,
    ].join(' && '),
  ]

  const vibeSync = {
    name: 'vibe-sync',
    image: 'alpine/git:latest',
    command: cloneCmd,
    volumeMounts: [{ name: 'app-data', mountPath: workDirSafe }],
  }
  if (gitToken) {
    vibeSync.env = [
      { name: 'GIT_USERNAME', valueFrom: { secretKeyRef: { name: secretName, key: 'username' } } },
      { name: 'GIT_TOKEN',    valueFrom: { secretKeyRef: { name: secretName, key: 'token' } } },
    ]
  }
  initContainers.push(vibeSync)

  // Init 2: dependency install — runs the appropriate package manager for the runtime.
  // Uses the same runtime image as the main container so native modules compile correctly.
  const installCmd = getInstallCommand(runtime, workDirSafe)
  if (installCmd) {
    initContainers.push({
      name: 'vibe-install',
      image: runtimeImage || 'node:20-alpine',
      command: ['sh', '-c', installCmd],
      volumeMounts: [{ name: 'app-data', mountPath: workDirSafe }],
    })
  }

  // Init 3: write .env if envVars present
  if (containerEnv.length > 0) {
    const envFileContent = (envVars || [])
      .filter((v) => v.key)
      .map((v) => `${v.key}=${v.value.replace(/\n/g, '\\n')}`)
      .join('\n')
    // Write .env using a busybox printf — escape single quotes in values
    const escapedContent = envFileContent.replace(/'/g, "'\\''")
    initContainers.push({
      name: 'vibe-env',
      image: 'busybox:1.36',
      command: ['sh', '-c', `printf '%s' '${escapedContent}' > ${workDirSafe}/.env`],
      volumeMounts: [{ name: 'app-data', mountPath: workDirSafe }],
    })
  }

  // Main container — use shell form (sh -c) to handle quoted args like nginx -g 'daemon off;'
  // Env vars are passed both as Kubernetes env (process.env) and written to .env by vibe-env
  // init container so apps work whether or not they use dotenv.
  const mainContainer = {
    name: safeApp,
    image: runtimeImage || 'node:20-alpine',
    command: startCmd ? ['sh', '-c', startCmd] : undefined,
    workingDir: workDirSafe,
    ports: [{ containerPort: port, protocol: 'TCP' }],
    volumeMounts: [{ name: 'app-data', mountPath: workDirSafe }],
    ...(containerEnv.length > 0 ? { env: containerEnv } : {}),
  }
  // Remove undefined command
  if (!mainContainer.command) delete mainContainer.command

  // Deployment
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: safeApp, namespace: ns, labels, annotations },
    spec: {
      replicas: instances || 1,
      selector: { matchLabels: { app: safeApp } },
      template: {
        metadata: { labels: { app: safeApp, 'managed-by': 'portainer-run' } },
        spec: {
          initContainers,
          containers: [mainContainer],
          volumes: [{ name: 'app-data', persistentVolumeClaim: { claimName: `${safeApp}-data` } }],
        },
      },
    },
  }

  // Note: the git credentials Secret is NOT committed to git.
  // It is created directly via the Kubernetes API after stack creation
  // so the token never appears in the repository.
  const manifests = [pvc, deployment].filter(Boolean)

  // Service
  if (exposeType !== 'none') {
    const svcType = exposeType === 'LoadBalancer' ? 'LoadBalancer'
      : exposeType === 'NodePort' ? 'NodePort'
      : 'ClusterIP'
    const svc = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: safeApp, namespace: ns, labels, annotations },
      spec: {
        type: svcType,
        selector: { app: safeApp },
        ports: [{ port, targetPort: port, protocol: 'TCP' }],
      },
    }
    manifests.push(svc)

    // Ingress
    if (exposeType === 'Ingress' && ingress?.host) {
      const ing = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: {
          name: safeApp, namespace: ns, labels, annotations,
          ...(ingress.ingressClass ? { annotations: { ...annotations, 'kubernetes.io/ingress.class': ingress.ingressClass } } : {}),
        },
        spec: {
          rules: [{
            host: ingress.host,
            http: {
              paths: [{
                path: ingress.path || '/',
                pathType: 'Prefix',
                backend: { service: { name: safeApp, port: { number: port } } },
              }],
            },
          }],
        },
      }
      manifests.push(ing)
    }
  }

  return manifests
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleVibeDeploy(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { gitTargetId, branch, pathPrefix, pollInterval, envId, envName, deployParams, vibeParams } = data

  if (!gitTargetId || !branch || !envId || !deployParams || !vibeParams) {
    return json(res, 400, { error: 'gitTargetId, branch, envId, deployParams, and vibeParams are required' })
  }

  const { appName, ns, instances, exposeType, servicePorts, ingress } = deployParams

  if (!appName || !ns) {
    return json(res, 400, { error: 'deployParams.appName and deployParams.ns are required' })
  }

  const { sourceFiles, sourceType, gitSource } = vibeParams
  const isGitSource = sourceType === 'git' && gitSource?.gitTargetId

  // Validate source
  if (!isGitSource && (!Array.isArray(sourceFiles) || sourceFiles.length === 0)) {
    return json(res, 400, { error: 'vibeParams.sourceFiles must be a non-empty array' })
  }
  if (isGitSource && (!gitSource.gitTargetId || !gitSource.branch)) {
    return json(res, 400, { error: 'gitSource.gitTargetId and gitSource.branch are required' })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })

  // For git source, load the source connection (may differ from manifests connection)
  const sourceConn = isGitSource ? getConnectionById(gitSource.gitTargetId) : conn
  if (!sourceConn) return json(res, 404, { error: 'Source git target not found' })

  const safeApp = sanitizeStackName(appName)
  const safePrefix = sanitizeGitPath(pathPrefix || conn.payload.pathPrefix || '')
  const safeEnvName = sanitizeGitPath(
    (envName || String(envId))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
  const gitToken = conn.payload.token || ''
  const gitUsername = conn.payload.username || ''
  // Source credentials come from the source connection, not the manifests connection
  const sourceGitToken = sourceConn.payload.token || ''
  const sourceGitUsername = sourceConn.payload.username || ''

  // Paths: <prefix>/<envName>/<ns>/<appName>.yaml and <prefix>/<envName>/<ns>/<appName>/src/
  const envPrefix = [safePrefix, safeEnvName].filter(Boolean).join('/')
  const sourcePath = sanitizeGitPath([envPrefix, ns, safeApp, 'src'].filter(Boolean).join('/'))
  const manifestPath = sanitizeGitPath(buildManifestPath({ pathPrefix: envPrefix, ns, appName: safeApp }))

  try {
    // 1. Ensure branch exists
    await ensureBranch(conn.payload, branch)

    const repoUrl = isGitSource
      ? buildRepoHttpsUrl(sourceConn.payload)
      : buildRepoHttpsUrl(conn.payload)
    const gitopsAnnotations = { gitTargetId, gitBranch: branch, gitPath: manifestPath }

    // 2. Commit source files to manifests git (upload mode only)
    //    Git source mode: files stay in their own repo — no commit needed here.
    const { runtime } = vibeParams
    if (!isGitSource) {
      let sourceCommits = sourceFiles
        .filter((f) => f.path && typeof f.content === 'string')
        .map((f) => ({
          path: `${sourcePath}/${sanitizeGitPath(f.path)}`,
          content: f.content,
        }))

      if (sourceCommits.length === 0) {
        return json(res, 400, { error: 'No valid source files to commit' })
      }

      // For nginx, rename single non-index HTML file to index.html
      if (runtime === 'nginx') {
        const hasIndex = sourceCommits.some((f) => f.path.endsWith('/index.html'))
        if (!hasIndex) {
          const htmlFiles = sourceCommits.filter((f) => f.path.match(/\.html?$/i))
          if (htmlFiles.length === 1) {
            const dir = htmlFiles[0].path.replace(/\/[^/]+$/, '')
            sourceCommits = sourceCommits.map((f) =>
              f === htmlFiles[0] ? { ...f, path: `${dir}/index.html` } : f
            )
          }
        }
      }

      await commitFiles(
        conn.payload,
        branch,
        `vibe: commit source for ${safeApp}`,
        sourceCommits,
      )
    }

    // 3. Build Kubernetes manifests
    // For git source: init container clones from the source repo directly.
    // For upload: init container clones from the manifests repo source path.
    const initCloneUrl = isGitSource
      ? buildRepoHttpsUrl(sourceConn.payload)
      : buildRepoHttpsUrl(conn.payload)
    const initBranch = isGitSource ? gitSource.branch : branch
    const initSourcePath = isGitSource
      ? (gitSource.path ? sanitizeGitPath(gitSource.path) : '')
      : sourcePath
    const initCredToken = isGitSource ? sourceGitToken : gitToken
    const initCredUsername = isGitSource ? sourceGitUsername : gitUsername

    const manifests = buildVibeManifests({
      appName: safeApp,
      ns,
      instances: instances || 1,
      vibeParams,
      exposeType: exposeType || 'none',
      servicePorts: servicePorts || [3000],
      ingress: ingress || {},
      gitopsAnnotations,
      gitRepoUrl: initCloneUrl,
      gitBranch: initBranch,
      gitSourcePath: initSourcePath,
      gitUsername: initCredUsername,
      gitToken: initCredToken,
    })

    // 4. Serialize and commit manifests
    const yamlContent = serializeManifests(manifests)

    await commitFiles(
      conn.payload,
      branch,
      `vibe: deploy ${safeApp} to ${ns}`,
      [{ path: manifestPath, content: yamlContent }],
    )

    // 5. Create the git credentials Secret in Kubernetes using SOURCE repo credentials.
    //    The init container needs credentials for the repo it clones from.
    if (initCredToken) {
      await createKubernetesSecret(req, {
        envId,
        ns,
        name: `${safeApp}-git-credentials`,
        data: {
          username: initCredUsername || 'oauth2',
          token: initCredToken,
        },
      })
    }

    // 6. Create Portainer GitOps stack (always uses manifests repo credentials)
    const interval = sanitizePollInterval(pollInterval)
    const stackResult = await createPortainerGitOpsStack(req, {
      envId,
      appName: safeApp,
      ns,
      repoUrl: buildRepoHttpsUrl(conn.payload),
      branch,
      filePath: manifestPath,
      username: gitUsername,
      token: gitToken,
      authType: conn.payload.authType || 'pat',
      pollInterval: interval,
    })

    return json(res, 200, {
      ok: true,
      appName: safeApp,
      ns,
      sourcePath,
      manifestPath,
      stackId: stackResult?.Id || stackResult?.id || null,
    })
  } catch (err) {
    console.error('[vibe deploy error]', err.message || err)
    return json(res, 500, { error: err.message || 'Deploy failed' })
  }
}

// ---------------------------------------------------------------------------
// Kubernetes Secret creation via Portainer proxy
// ---------------------------------------------------------------------------

/**
 * Creates (or replaces) a Kubernetes Secret via the Portainer Kubernetes proxy.
 * The Secret never touches git.
 */
async function createKubernetesSecret(req, { envId, ns, name, data }) {
  const target = resolvePortainerTarget(req)
  if (!target) throw new Error('Cannot resolve Portainer target')
  const userToken = req.headers['x-api-key'] || ''

  // Base64-encode the secret values (Kubernetes Secret data must be base64)
  const encodedData = {}
  for (const [k, v] of Object.entries(data)) {
    encodedData[k] = Buffer.from(String(v)).toString('base64')
  }

  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: ns },
    type: 'Opaque',
    data: encodedData,
  }

  const body = JSON.stringify(secret)

  // Try create first; if it already exists (409), use replace
  try {
    await portainerRequest(
      target, userToken, 'POST',
      `/api/endpoints/${envId}/kubernetes/api/v1/namespaces/${ns}/secrets`,
      body,
    )
  } catch (e) {
    if (e.message && e.message.includes('409')) {
      // Already exists — replace it
      await portainerRequest(
        target, userToken, 'PUT',
        `/api/endpoints/${envId}/kubernetes/api/v1/namespaces/${ns}/secrets/${name}`,
        body,
      )
    } else {
      throw e
    }
  }
}

// ---------------------------------------------------------------------------
// Portainer stack creation (mirrors gitops.js)
// ---------------------------------------------------------------------------

async function createPortainerGitOpsStack(req, {
  envId, appName, ns, repoUrl, branch, filePath,
  username, token, authType, pollInterval,
}) {
  const target = resolvePortainerTarget(req)
  if (!target) throw new Error('Cannot resolve Portainer target')

  const userToken = req.headers['x-api-key'] || ''

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

  const bodyStr = JSON.stringify(stackBody)
  return portainerRequest(
    target,
    userToken,
    'POST',
    `/api/stacks/create/kubernetes/repository?endpointId=${envId}`,
    bodyStr,
  )
}

function portainerRequest(target, userToken, method, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const transport = target.isHttps ? https : http
    const headers = { 'Content-Type': contentType, Accept: 'application/json' }
    if (userToken) headers['X-API-Key'] = userToken
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

// ---------------------------------------------------------------------------
// Vibe Update handler
// ---------------------------------------------------------------------------

/**
 * POST /api/vibe/update
 * Body: {
 *   gitTargetId, branch, sourcePath,
 *   sourceFiles: [{ path, content }]
 * }
 *
 * Commits updated source files to the existing source path in git.
 * The caller is responsible for triggering a rollout restart on the Deployment
 * so the init container re-runs and picks up the new files.
 */
async function handleVibeUpdate(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { gitTargetId, branch, sourcePath, sourceFiles } = data

  if (!gitTargetId || !branch || !sourcePath) {
    return json(res, 400, { error: 'gitTargetId, branch, and sourcePath are required' })
  }

  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    return json(res, 400, { error: 'sourceFiles must be a non-empty array' })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })

  const safeSourcePath = sanitizeGitPath(sourcePath)

  try {
    await ensureBranch(conn.payload, branch)

    const commits = sourceFiles
      .filter((f) => f.path && typeof f.content === 'string')
      .map((f) => ({
        path: `${safeSourcePath}/${sanitizeGitPath(f.path)}`,
        content: f.content,
      }))

    if (commits.length === 0) {
      return json(res, 400, { error: 'No valid source files to commit' })
    }

    const result = await commitFiles(
      conn.payload,
      branch,
      `vibe: update source for ${safeSourcePath.split('/').pop()}`,
      commits,
    )

    return json(res, 200, { ok: true, sha: result.sha, fileCount: commits.length })
  } catch (err) {
    console.error('[vibe update error]', err.message || err)
    return json(res, 500, { error: err.message || 'Update failed' })
  }
}

// ---------------------------------------------------------------------------
// Vibe Update Exposure handler
// ---------------------------------------------------------------------------

/**
 * POST /api/vibe/update-exposure
 * Body: {
 *   gitTargetId, branch, gitPath, appName, ns,
 *   exposeType: 'none' | 'NodePort' | 'LoadBalancer' | 'Ingress',
 *   port: number,
 *   ingress?: { host, path, ingressClass }
 * }
 *
 * Fetches the existing manifest from git, replaces the Service and Ingress
 * documents with a regenerated version matching the new exposure settings,
 * and commits the updated file back.
 */
async function handleVibeUpdateExposure(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { gitTargetId, branch, gitPath, appName, ns, exposeType, port, ingress } = data
  if (!gitTargetId || !branch || !gitPath || !appName || !ns) {
    return json(res, 400, { error: 'gitTargetId, branch, gitPath, appName and ns are required' })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })

  try {
    // Fetch current manifest
    const current = await fetchFile(conn.payload, branch, gitPath)
    if (!current) return json(res, 404, { error: 'Manifest file not found in git' })

    // Split multi-document YAML, strip Service and Ingress docs, keep the rest
    const docs = current.split(/^---\s*$/m).map((d) => d.trim()).filter(Boolean)
    const kept = docs.filter((d) => {
      const kindMatch = d.match(/^kind:\s*(\S+)/m)
      const kind = kindMatch ? kindMatch[1] : ''
      return kind !== 'Service' && kind !== 'Ingress'
    })

    // Build new Service and Ingress docs if needed
    const safeApp = sanitizeStackName(appName)
    const svcPort = Number(port) || 80
    const labels = { app: safeApp, 'managed-by': 'portainer-run' }

    const newDocs = [...kept]

    if (exposeType !== 'none') {
      const svcType = exposeType === 'LoadBalancer' ? 'LoadBalancer'
        : exposeType === 'NodePort' ? 'NodePort'
        : 'ClusterIP'

      const svc = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: safeApp, namespace: ns, labels },
        spec: {
          type: svcType,
          selector: { app: safeApp },
          ports: [{ port: svcPort, targetPort: svcPort, protocol: 'TCP' }],
        },
      }
      newDocs.push(serializeManifests([svc]).trim())

      if (exposeType === 'Ingress' && ingress?.host) {
        const ing = {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'Ingress',
          metadata: {
            name: safeApp,
            namespace: ns,
            labels,
            ...(ingress.ingressClass ? { annotations: { 'kubernetes.io/ingress.class': ingress.ingressClass } } : {}),
          },
          spec: {
            rules: [{
              host: ingress.host,
              http: { paths: [{ path: ingress.path || '/', pathType: 'Prefix', backend: { service: { name: safeApp, port: { number: svcPort } } } }] },
            }],
          },
        }
        newDocs.push(serializeManifests([ing]).trim())
      }
    }

    const updatedYaml = newDocs.join('\n---\n') + '\n'

    await commitFiles(conn.payload, branch, `vibe: update exposure for ${safeApp}`, [
      { path: gitPath, content: updatedYaml },
    ])

    return json(res, 200, { ok: true })
  } catch (err) {
    console.error('[vibe update-exposure error]', err.message || err)
    return json(res, 500, { error: err.message || 'Update failed' })
  }
}

// ---------------------------------------------------------------------------
// Vibe manifest exposure reader
// ---------------------------------------------------------------------------

/**
 * GET /api/vibe/manifest-exposure?gitTargetId=&branch=&gitPath=
 *
 * Fetches the manifest YAML from git and parses the current Service
 * exposure settings so the edit form can pre-populate correctly.
 */
async function handleVibeManifestExposure(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const gitTargetId = url.searchParams.get('gitTargetId')
  const branch = url.searchParams.get('branch')
  const gitPath = url.searchParams.get('gitPath')

  if (!gitTargetId || !branch || !gitPath) {
    return json(res, 400, { error: 'gitTargetId, branch and gitPath are required' })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })

  try {
    const content = await fetchFile(conn.payload, branch, gitPath)
    if (!content) return json(res, 404, { error: 'Manifest not found' })

    // Find the Service document
    const docs = content.split(/^---\s*$/m).map((d) => d.trim()).filter(Boolean)
    const svcDoc = docs.find((d) => /^kind:\s*Service/m.test(d))
    const ingDoc = docs.find((d) => /^kind:\s*Ingress/m.test(d))

    if (!svcDoc) return json(res, 200, { exposeType: 'none' })

    // Parse type and port from the Service doc using regex (no YAML parser needed)
    const typeMatch = svcDoc.match(/^\s+type:\s*(\S+)/m)
    const portMatch = svcDoc.match(/^\s+port:\s*(\d+)/m)
    const svcType = typeMatch ? typeMatch[1] : 'ClusterIP'
    const port = portMatch ? Number(portMatch[1]) : 80

    let exposeType = 'none'
    if (svcType === 'NodePort') exposeType = 'NodePort'
    else if (svcType === 'LoadBalancer') exposeType = 'LoadBalancer'
    else if (svcType === 'ClusterIP' && ingDoc) exposeType = 'Ingress'

    const result = { exposeType, port }

    if (ingDoc) {
      const hostMatch = ingDoc.match(/^\s+host:\s*(\S+)/m)
      const pathMatch = ingDoc.match(/^\s+path:\s*(\S+)/m)
      const classMatch = ingDoc.match(/kubernetes\.io\/ingress\.class:\s*(\S+)/m)
      if (hostMatch) result.ingHost = hostMatch[1]
      if (pathMatch) result.ingPath = pathMatch[1]
      if (classMatch) result.ingClass = classMatch[1]
    }

    return json(res, 200, result)
  } catch (err) {
    console.error('[vibe manifest-exposure error]', err.message || err)
    return json(res, 500, { error: err.message || 'Failed to read manifest' })
  }
}
