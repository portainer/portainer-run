import { readBody } from '../lib/http.js'
import { CORS } from '../lib/cors.js'
import { getConnectionById } from '../models/connection.js'
import {
  commitFiles,
  ensureBranch,
  buildRepoHttpsUrl,
  fetchFile,
  deleteFile,
  deleteDirectory,
  deletePaths,
} from '../proxy/git.js'
import {
  buildManifests,
  serializeManifests,
  buildManifestPath,
} from '../lib/manifestSerialize.js'
import yaml from 'js-yaml'
import { resolvePortainerTarget } from '../resolve-portainer.js'
import {
  resolveCallerIdentity,
  extractToken,
  portainerAuthHeaders,
} from '../lib/identity.js'
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
  if (!extractToken(req)) {
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

  if (pathname === '/api/vibe/manifest-env' && req.method === 'GET') {
    return handleVibeManifestEnv(req, res)
  }

  if (pathname === '/api/vibe/update-env' && req.method === 'POST') {
    return handleVibeUpdateEnv(req, res)
  }

  if (pathname === '/api/vibe/delete-manifest' && req.method === 'POST') {
    return handleVibeDeleteManifest(req, res)
  }

  if (pathname === '/api/vibe/delete-stack' && req.method === 'POST') {
    return handleVibeDeleteStack(req, res)
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
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Runtime install commands
// ---------------------------------------------------------------------------

/**
 * Returns the runtime environment variables the main container needs so the
 * interpreter finds dependencies installed into the shared PV by the install
 * init container. Kept in sync with getInstallCommand: only python and ruby
 * install outside the working directory and therefore need path hints. Node
 * (node_modules) and php (vendor) install into the working directory already.
 *
 * @param {string} runtime
 * @param {string} workDir
 * @returns {{name: string, value: string}[]}
 */
function getRuntimeEnv(runtime, workDir) {
  switch (runtime) {
    case 'python':
      return [
        { name: 'PYTHONPATH', value: `${workDir}/.pydeps` },
        {
          name: 'PATH',
          value: `${workDir}/.pydeps/bin:/usr/local/bin:/usr/bin:/bin`,
        },
      ]
    case 'ruby':
      return [
        { name: 'BUNDLE_PATH', value: `${workDir}/.bundle` },
        { name: 'BUNDLE_GEMFILE', value: `${workDir}/Gemfile` },
        { name: 'GEM_HOME', value: `${workDir}/.bundle` },
        { name: 'GEM_PATH', value: `${workDir}/.bundle` },
        {
          name: 'PATH',
          value: `${workDir}/.bundle/bin:/usr/local/bundle/bin:/usr/local/bin:/usr/bin:/bin`,
        },
      ]
    default:
      return []
  }
}

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
      // npm installs node_modules into the working directory, which is on the PV.
      return `cd ${workDir} && if [ -f package.json ]; then npm install --production 2>&1; fi`
    case 'python':
      // pip's default target is the image's system site-packages, which live
      // OUTSIDE the shared PV and so are lost when this init container exits.
      // Install into a PV-local directory instead (libraries + console scripts
      // under ${workDir}/.pydeps and ${workDir}/.pydeps/bin) so the main
      // container can see them via PYTHONPATH/PATH.
      return `cd ${workDir} && if [ -f requirements.txt ]; then pip install --no-cache-dir --target=${workDir}/.pydeps -r requirements.txt; fi`
    case 'ruby':
      // Same problem as pip: default gem install location is outside the PV.
      // Vendor gems into a PV-local path so they persist into the main container.
      return `cd ${workDir} && if [ -f Gemfile ]; then bundle config set --local path '${workDir}/.bundle' && bundle install; fi`
    case 'php':
      // composer installs vendor/ into the working directory, which is on the PV.
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
// Sane resource defaults for the short-lived init containers, so a cluster with
// a ResourceQuota or LimitRange does not reject the pod. The clone container
// gets more memory headroom (git checks out the source tree); the env writer is
// tiny. The dependency installer is intentionally not defaulted here.
const INIT_CLONE_RESOURCES = {
  requests: { cpu: '50m', memory: '128Mi' },
  limits: { cpu: '250m', memory: '512Mi' },
}
const INIT_ENV_RESOURCES = {
  requests: { cpu: '50m', memory: '64Mi' },
  limits: { cpu: '250m', memory: '256Mi' },
}
// The dependency installer does real work (npm/pip/bundle) and can spike memory.
// Init containers run sequentially, so this limit governs init-phase scheduling
// (Kubernetes takes the max across init containers). Raise the limit if apps
// pull heavy dependency trees that OOM at 2Gi.
const INIT_INSTALL_RESOURCES = {
  requests: { cpu: '100m', memory: '256Mi' },
  limits: { cpu: '1', memory: '2Gi' },
}

// --- Pod Security Standards (issue #39) ---------------------------------------
// Applied to the app container and every init container. We harden with the
// flags that are safe across the images used here (alpine/git, busybox, and
// arbitrary user runtime images that typically start as root and write into the
// mounted PV): drop all capabilities, block privilege escalation, and pin the
// default seccomp profile. We deliberately do NOT force runAsNonRoot or
// readOnlyRootFilesystem, because the sync/install/env init steps and many
// vibe-built images legitimately need to write to the filesystem and run as
// their image's default user. This matches the Kubernetes "baseline"/restricted
// intent without breaking the deploy flow.
const CONTAINER_SECURITY_CONTEXT = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
}

// Some runtime images de-privilege at startup: they start as root, chown their
// working/cache dirs to a worker user, and bind a privileged port (80). With ALL
// capabilities dropped they fail at boot ("Operation not permitted" on chown).
// nginx is handled by switching to the unprivileged image; php-apache has no
// clean unprivileged official image, so the php runtime is granted back the
// minimum capabilities it needs. This is a deliberate, scoped exception to the
// baseline for the php runtime only (see #39).
const WEBSERVER_RUNTIME_CAPS = ['CHOWN', 'SETUID', 'SETGID', 'NET_BIND_SERVICE']
const RUNTIMES_NEEDING_CAPS = new Set(['php'])

// Pod-level context: never mount the service account token (the workloads
// deployed here never call the Kubernetes API) and pin the default seccomp
// profile at the pod level so it is inherited by anything without its own.
const POD_SECURITY_CONTEXT = {
  seccompProfile: { type: 'RuntimeDefault' },
}

/**
 * Attach the hardened container securityContext, preserving any existing keys.
 * Pass a runtime id to grant the scoped capability exception for runtimes whose
 * image de-privileges at startup (currently php).
 */
function harden(container, runtime) {
  if (!container || typeof container !== 'object') return container
  const base = { ...CONTAINER_SECURITY_CONTEXT }
  if (runtime && RUNTIMES_NEEDING_CAPS.has(runtime)) {
    base.capabilities = { drop: ['ALL'], add: [...WEBSERVER_RUNTIME_CAPS] }
  }
  container.securityContext = {
    ...base,
    ...(container.securityContext || {}),
  }
  return container
}

// --- Sensitive ENV detection (issue #38) --------------------------------------
// Env keys whose names imply a secret must not be written into the committed
// manifest (the vibe-env init container embeds .env values in plaintext inside
// the Deployment YAML). Matching keys are instead stored in a Kubernetes Secret
// and referenced with secretKeyRef, so the value never touches git.
//
// Word-boundary matching on common secret-bearing tokens. Case-insensitive.
const SENSITIVE_ENV_PATTERN =
  /(^|[^A-Z])(PASSWORD|PASSWD|PASS|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH|DSN|CONNECTION[_-]?STRING|CERT|SIGNING)([^A-Z]|$)/i

/** True when an env key name implies its value is sensitive. */
export function isSensitiveEnvKey(key) {
  return SENSITIVE_ENV_PATTERN.test(String(key || ''))
}

/** The Kubernetes Secret name that holds an app's sensitive env values. */
function appSecretName(safeApp) {
  return `${safeApp}-app-secrets`
}

/**
 * Split env vars into plaintext (safe to commit) and sensitive (stored in a
 * Secret). Returns { plain: [{key,value}], sensitive: [{key,value}] }.
 */
function splitSensitiveEnv(envVars) {
  const plain = []
  const sensitive = []
  for (const v of envVars || []) {
    if (!v || !v.key) continue
    if (isSensitiveEnvKey(v.key)) sensitive.push(v)
    else plain.push(v)
  }
  return { plain, sensitive }
}

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
    'portainer-run/deploy-type': 'vibe',
    'portainer-run/git-target-id': gitopsAnnotations.gitTargetId,
    'portainer-run/git-branch': gitopsAnnotations.gitBranch,
    'portainer-run/git-path': gitopsAnnotations.gitPath,
    ...(gitSourcePath
      ? { 'portainer-run/vibe-source-path': gitSourcePath }
      : {}),
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

  // Split env into plaintext (safe to commit) and sensitive (stored in a Secret).
  // Sensitive values are referenced via secretKeyRef so they never appear in the
  // committed manifest. See issue #38.
  const { plain: plainEnv, sensitive: sensitiveEnv } =
    splitSensitiveEnv(envVars)
  const hasSecrets = sensitiveEnv.length > 0
  const secretForApp = appSecretName(safeApp)

  // Build env array for the main container:
  //  - plaintext vars inline
  //  - sensitive vars sourced from the app-secrets Secret
  const userEnv = [
    ...plainEnv.map((v) => ({ name: v.key, value: v.value })),
    ...sensitiveEnv.map((v) => ({
      name: v.key,
      valueFrom: { secretKeyRef: { name: secretForApp, key: v.key } },
    })),
  ]

  // Runtime env so the interpreter finds deps installed into the PV by the
  // install init container. These take precedence over user-supplied vars on
  // collision (e.g. PYTHONPATH, PATH), so the app can actually locate its
  // dependencies. Merge by key to avoid emitting duplicate env entries.
  const runtimeEnv = getRuntimeEnv(runtime, workDirSafe)
  const envByName = new Map()
  for (const e of userEnv) envByName.set(e.name, e)
  for (const e of runtimeEnv) envByName.set(e.name, e) // runtime wins on collision
  const containerEnv = [...envByName.values()]

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
    'sh',
    '-c',
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
    resources: INIT_CLONE_RESOURCES,
    volumeMounts: [{ name: 'app-data', mountPath: workDirSafe }],
  }
  if (gitToken) {
    vibeSync.env = [
      {
        name: 'GIT_USERNAME',
        valueFrom: { secretKeyRef: { name: secretName, key: 'username' } },
      },
      {
        name: 'GIT_TOKEN',
        valueFrom: { secretKeyRef: { name: secretName, key: 'token' } },
      },
    ]
  }
  initContainers.push(vibeSync)

  // Init 2: dependency install — runs the appropriate package manager for the runtime.
  // Uses the same runtime image as the main container so native modules compile correctly.
  const installCmd = getInstallCommand(runtime, workDirSafe)
  if (installCmd) {
    initContainers.push({
      name: 'vibe-install',
      image: runtimeImage || 'node:22',
      command: ['sh', '-c', installCmd],
      resources: INIT_INSTALL_RESOURCES,
      volumeMounts: [{ name: 'app-data', mountPath: workDirSafe }],
    })
  }

  // Init 3: write .env with the NON-sensitive vars only.
  // Sensitive values are delivered to the container via secretKeyRef (process.env)
  // and are deliberately never written into this committed init command. See #38.
  if (plainEnv.length > 0) {
    const envFileContent = plainEnv
      .map((v) => `${v.key}=${String(v.value ?? '').replace(/\n/g, '\\n')}`)
      .join('\n')
    // Write .env using a busybox printf — escape single quotes in values
    const escapedContent = envFileContent.replace(/'/g, "'\\''")
    initContainers.push({
      name: 'vibe-env',
      image: 'busybox:1.36',
      command: [
        'sh',
        '-c',
        `printf '%s' '${escapedContent}' > ${workDirSafe}/.env`,
      ],
      resources: INIT_ENV_RESOURCES,
      volumeMounts: [{ name: 'app-data', mountPath: workDirSafe }],
    })
  }

  // Main container — use shell form (sh -c) to handle quoted args like nginx -g 'daemon off;'
  // Env vars are passed both as Kubernetes env (process.env) and written to .env by vibe-env
  // init container so apps work whether or not they use dotenv.
  const mainContainer = {
    name: safeApp,
    image: runtimeImage || 'node:22',
    command: startCmd ? ['sh', '-c', startCmd] : undefined,
    workingDir: workDirSafe,
    ports: [{ containerPort: port, protocol: 'TCP' }],
    volumeMounts: [{ name: 'app-data', mountPath: workDirSafe }],
    resources: {
      requests: { cpu: '100m', memory: '1Gi' },
      limits: { cpu: '1', memory: '4Gi' },
    },
    ...(containerEnv.length > 0 ? { env: containerEnv } : {}),
  }
  // Remove undefined command
  if (!mainContainer.command) delete mainContainer.command

  // Pod Security Standards (issue #39): harden the app container and every
  // init container, and lock down the pod (no service account token).
  harden(mainContainer, runtime)
  for (const ic of initContainers) harden(ic)

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
          securityContext: POD_SECURITY_CONTEXT,
          automountServiceAccountToken: false,
          initContainers,
          containers: [mainContainer],
          volumes: [
            {
              name: 'app-data',
              persistentVolumeClaim: { claimName: `${safeApp}-data` },
            },
          ],
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
    const svcType =
      exposeType === 'LoadBalancer'
        ? 'LoadBalancer'
        : exposeType === 'NodePort'
          ? 'NodePort'
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
          name: safeApp,
          namespace: ns,
          labels,
          annotations: ingress.ingressClass
            ? {
                ...annotations,
                'kubernetes.io/ingress.class': ingress.ingressClass,
              }
            : annotations,
        },
        spec: {
          // Set spec.ingressClassName (the canonical field; the matching
          // annotation above is kept for legacy controllers).
          ...(ingress.ingressClass
            ? { ingressClassName: ingress.ingressClass }
            : {}),
          rules: [
            {
              host: ingress.host,
              http: {
                paths: [
                  {
                    path: ingress.path || '/',
                    pathType: 'Prefix',
                    backend: {
                      service: { name: safeApp, port: { number: port } },
                    },
                  },
                ],
              },
            },
          ],
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

  const {
    gitTargetId,
    branch,
    pathPrefix,
    pollInterval,
    envId,
    envName,
    deployParams,
    vibeParams,
  } = data

  if (!gitTargetId || !branch || !envId || !deployParams || !vibeParams) {
    return json(res, 400, {
      error:
        'gitTargetId, branch, envId, deployParams, and vibeParams are required',
    })
  }

  const { appName, ns, instances, exposeType, servicePorts, ingress } =
    deployParams

  if (!appName || !ns) {
    return json(res, 400, {
      error: 'deployParams.appName and deployParams.ns are required',
    })
  }

  const { sourceFiles, sourceType, gitSource } = vibeParams
  const isGitSource = sourceType === 'git' && gitSource?.gitTargetId

  // Validate source
  if (
    !isGitSource &&
    (!Array.isArray(sourceFiles) || sourceFiles.length === 0)
  ) {
    return json(res, 400, {
      error: 'vibeParams.sourceFiles must be a non-empty array',
    })
  }
  if (isGitSource && (!gitSource.gitTargetId || !gitSource.branch)) {
    return json(res, 400, {
      error: 'gitSource.gitTargetId and gitSource.branch are required',
    })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })

  // Verify the caller can access the manifests git target (owner or shared)
  const callerIdentity = await resolveCallerIdentity(req)
  const callerId = callerIdentity?.userId || '_unknown'
  const callerIsAdmin = callerIdentity?.isAdmin || false
  if (!callerIsAdmin && conn.owner_id !== callerId && !conn.shared) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }

  // For git source, load the source connection and verify access separately
  const sourceConn = isGitSource
    ? getConnectionById(gitSource.gitTargetId)
    : conn
  if (!sourceConn)
    return json(res, 404, { error: 'Source git target not found' })
  if (
    isGitSource &&
    !callerIsAdmin &&
    sourceConn.owner_id !== callerId &&
    !sourceConn.shared
  ) {
    return json(res, 403, {
      error: 'Forbidden — source git target not accessible',
    })
  }

  const safeApp = sanitizeStackName(appName)
  const safePrefix = sanitizeGitPath(
    pathPrefix || conn.payload.pathPrefix || '',
  )
  const safeEnvName = sanitizeGitPath(
    (envName || String(envId))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  )
  const gitToken = conn.payload.token || ''
  const gitUsername = conn.payload.username || ''
  // Source credentials come from the source connection, not the manifests connection
  const sourceGitToken = sourceConn.payload.token || ''
  const sourceGitUsername = sourceConn.payload.username || ''

  // Paths: <prefix>/<envName>/<ns>/<appName>.yaml and <prefix>/<envName>/<ns>/<appName>/src/
  const envPrefix = [safePrefix, safeEnvName].filter(Boolean).join('/')
  const sourcePath = sanitizeGitPath(
    [envPrefix, ns, safeApp, 'src'].filter(Boolean).join('/'),
  )
  const manifestPath = sanitizeGitPath(
    buildManifestPath({ pathPrefix: envPrefix, ns, appName: safeApp }),
  )

  try {
    // 1. Ensure branch exists
    await ensureBranch(conn.payload, branch)

    const repoUrl = isGitSource
      ? buildRepoHttpsUrl(sourceConn.payload)
      : buildRepoHttpsUrl(conn.payload)
    const gitopsAnnotations = {
      gitTargetId,
      gitBranch: branch,
      gitPath: manifestPath,
    }

    // 2. Prepare source file commits (upload mode only).
    //    Git source mode: files stay in their own repo — no commit needed here.
    //    Source commits and the manifest are intentionally written in a single
    //    atomic git commit below so there is never a window where the manifest
    //    exists without its source files (or vice-versa).
    const { runtime } = vibeParams
    let sourceCommits = []
    if (!isGitSource) {
      sourceCommits = sourceFiles
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
        const hasIndex = sourceCommits.some((f) =>
          f.path.endsWith('/index.html'),
        )
        if (!hasIndex) {
          const htmlFiles = sourceCommits.filter((f) =>
            f.path.match(/\.html?$/i),
          )
          if (htmlFiles.length === 1) {
            const dir = htmlFiles[0].path.replace(/\/[^/]+$/, '')
            sourceCommits = sourceCommits.map((f) =>
              f === htmlFiles[0] ? { ...f, path: `${dir}/index.html` } : f,
            )
          }
        }
      }
    }

    // 3. Build Kubernetes manifests
    // For git source: init container clones from the source repo directly.
    // For upload: init container clones from the manifests repo source path.
    const initCloneUrl = isGitSource
      ? buildRepoHttpsUrl(sourceConn.payload)
      : buildRepoHttpsUrl(conn.payload)
    const initBranch = isGitSource ? gitSource.branch : branch
    const initSourcePath = isGitSource
      ? gitSource.path
        ? sanitizeGitPath(gitSource.path)
        : ''
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

    // 4. Commit source files + manifest in a single atomic commit.
    //    Previously these were two sequential commits, which meant the second
    //    commitGitHub call could fetch a stale base_tree (or hit the silent
    //    catch{} on a transient GET failure) and create a fresh tree containing
    //    only the manifest — wiping the source files from the branch.
    const yamlContent = serializeManifests(manifests)

    await commitFiles(
      conn.payload,
      branch,
      `vibe: deploy ${safeApp} to ${ns}`,
      [...sourceCommits, { path: manifestPath, content: yamlContent }],
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

    // 5b. Create the app-secrets Secret for any sensitive env vars (issue #38).
    //     These values are referenced by the Deployment via secretKeyRef and are
    //     never written into the committed manifest.
    const { sensitive: sensitiveEnv } = splitSensitiveEnv(
      vibeParams.envVars || [],
    )
    if (sensitiveEnv.length > 0) {
      await createKubernetesSecret(req, {
        envId,
        ns,
        name: `${safeApp}-app-secrets`,
        data: Object.fromEntries(
          sensitiveEnv.map((v) => [v.key, String(v.value ?? '')]),
        ),
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
    console.error('[vibe deploy error]', {
      message: err?.message || String(err),
      status: err?.status,
      method: err?.method,
      url: err?.url,
      appName: safeApp,
      ns,
      envId,
      manifestPath,
      stack: err?.stack,
    })
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
  const target = resolvePortainerTarget()
  if (!target) throw new Error('Cannot resolve Portainer target')
  const userToken = extractToken(req)

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
      target,
      userToken,
      'POST',
      `/api/endpoints/${envId}/kubernetes/api/v1/namespaces/${ns}/secrets`,
      body,
    )
  } catch (e) {
    if (e.message && e.message.includes('409')) {
      // Already exists — replace it
      await portainerRequest(
        target,
        userToken,
        'PUT',
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

async function createPortainerGitOpsStack(
  req,
  {
    envId,
    appName,
    ns,
    repoUrl,
    branch,
    filePath,
    username,
    token,
    authType,
    pollInterval,
  },
) {
  const target = resolvePortainerTarget()
  if (!target) throw new Error('Cannot resolve Portainer target')

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
    ...(authType === 'pat' && token
      ? {
          RepositoryAuthentication: true,
          RepositoryAuthorizationType: 0,
          RepositoryUsername: username || 'oauth2',
          RepositoryPassword: token,
        }
      : {
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

function portainerRequest(
  target,
  userToken,
  method,
  path,
  body,
  contentType = 'application/json',
) {
  return new Promise((resolve, reject) => {
    const transport = target.isHttps ? https : http
    const headers = { 'Content-Type': contentType, Accept: 'application/json' }
    if (userToken) Object.assign(headers, portainerAuthHeaders(userToken))
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
          // Keep the method/path/status alongside Portainer's own message so a
          // routing 404 ("Not Found") is distinguishable from a resource 404.
          let detail = ''
          try {
            const parsed = JSON.parse(text)
            detail = parsed?.message || parsed?.details || ''
          } catch {
            /* ignore */
          }
          const err = new Error(
            `Portainer ${method} ${path.split('?')[0]} → HTTP ${upRes.statusCode}` +
              (detail ? `: ${detail}` : ''),
          )
          err.status = upRes.statusCode
          err.method = method
          err.url = path.split('?')[0]
          return reject(err)
        }
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve(text)
        }
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
    return json(res, 400, {
      error: 'gitTargetId, branch, and sourcePath are required',
    })
  }

  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    return json(res, 400, { error: 'sourceFiles must be a non-empty array' })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })
  const viCaller1 = await resolveCallerIdentity(req)
  if (
    !viCaller1?.isAdmin &&
    conn.owner_id !== (viCaller1?.userId || '_unknown') &&
    !conn.shared
  ) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }

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

    return json(res, 200, {
      ok: true,
      sha: result.sha,
      fileCount: commits.length,
    })
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

  const {
    gitTargetId,
    branch,
    gitPath,
    appName,
    ns,
    exposeType,
    port,
    ingress,
  } = data
  if (!gitTargetId || !branch || !gitPath || !appName || !ns) {
    return json(res, 400, {
      error: 'gitTargetId, branch, gitPath, appName and ns are required',
    })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })
  const viCaller2 = await resolveCallerIdentity(req)
  if (
    !viCaller2?.isAdmin &&
    conn.owner_id !== (viCaller2?.userId || '_unknown') &&
    !conn.shared
  ) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }

  try {
    // Fetch current manifest
    const current = await fetchFile(conn.payload, branch, gitPath)
    if (!current)
      return json(res, 404, { error: 'Manifest file not found in git' })

    // Split multi-document YAML, strip Service and Ingress docs, keep the rest
    const docs = current
      .split(/^---\s*$/m)
      .map((d) => d.trim())
      .filter(Boolean)
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
      const svcType =
        exposeType === 'LoadBalancer'
          ? 'LoadBalancer'
          : exposeType === 'NodePort'
            ? 'NodePort'
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
            ...(ingress.ingressClass
              ? {
                  annotations: {
                    'kubernetes.io/ingress.class': ingress.ingressClass,
                  },
                }
              : {}),
          },
          spec: {
            // Set spec.ingressClassName (the canonical field; the matching
            // annotation above is kept for legacy controllers).
            ...(ingress.ingressClass
              ? { ingressClassName: ingress.ingressClass }
              : {}),
            rules: [
              {
                host: ingress.host,
                http: {
                  paths: [
                    {
                      path: ingress.path || '/',
                      pathType: 'Prefix',
                      backend: {
                        service: { name: safeApp, port: { number: svcPort } },
                      },
                    },
                  ],
                },
              },
            ],
          },
        }
        newDocs.push(serializeManifests([ing]).trim())
      }
    }

    const updatedYaml = newDocs.join('\n---\n') + '\n'

    await commitFiles(
      conn.payload,
      branch,
      `vibe: update exposure for ${safeApp}`,
      [{ path: gitPath, content: updatedYaml }],
    )

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
    return json(res, 400, {
      error: 'gitTargetId, branch and gitPath are required',
    })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })
  const viCaller3 = await resolveCallerIdentity(req)
  if (
    !viCaller3?.isAdmin &&
    conn.owner_id !== (viCaller3?.userId || '_unknown') &&
    !conn.shared
  ) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }

  try {
    const content = await fetchFile(conn.payload, branch, gitPath)
    if (!content) return json(res, 404, { error: 'Manifest not found' })

    // Parse every YAML document and locate the Service / Ingress objects.
    const docs = yaml
      .loadAll(content)
      .filter((d) => d && typeof d === 'object')
    const svc = docs.find((d) => d.kind === 'Service')
    const ing = docs.find((d) => d.kind === 'Ingress')

    if (!svc) return json(res, 200, { exposeType: 'none' })

    const svcType = svc.spec?.type || 'ClusterIP'
    const port = svc.spec?.ports?.[0]?.port ?? 80

    let exposeType = 'none'
    if (svcType === 'NodePort') exposeType = 'NodePort'
    else if (svcType === 'LoadBalancer') exposeType = 'LoadBalancer'
    else if (svcType === 'ClusterIP' && ing) exposeType = 'Ingress'

    const result = { exposeType, port }

    if (ing) {
      const rule = ing.spec?.rules?.[0]
      const host = rule?.host
      const path = rule?.http?.paths?.[0]?.path
      // Prefer spec.ingressClassName; fall back to the legacy annotation for
      // manifests written before the switch.
      const ingClass =
        ing.spec?.ingressClassName ||
        ing.metadata?.annotations?.['kubernetes.io/ingress.class']
      if (host) result.ingHost = host
      if (path) result.ingPath = path
      if (ingClass) result.ingClass = ingClass
    }

    return json(res, 200, result)
  } catch (err) {
    console.error('[vibe manifest-exposure error]', err.message || err)
    return json(res, 500, { error: err.message || 'Failed to read manifest' })
  }
}

// ---------------------------------------------------------------------------
// Vibe environment-variable reader / writer
// ---------------------------------------------------------------------------

/** Locate the Deployment document and its main application container. */
function findDeploymentContainer(docs) {
  const deployment = docs.find((d) => d && d.kind === 'Deployment')
  if (!deployment) return { deployment: null, container: null, podSpec: null }
  const podSpec = deployment.spec?.template?.spec || {}
  const containers = podSpec.containers || []
  const appName = deployment.metadata?.name
  const container =
    containers.find((c) => c.name === appName) || containers[0] || null
  return { deployment, container, podSpec }
}

/**
 * GET /api/vibe/manifest-env?gitTargetId=&branch=&gitPath=
 *
 * Reads the committed manifest and returns the application container's
 * environment variables as [{ key, value }] so the edit form can
 * pre-populate. The manifest in git is the source of truth.
 */
async function handleVibeManifestEnv(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const gitTargetId = url.searchParams.get('gitTargetId')
  const branch = url.searchParams.get('branch')
  const gitPath = url.searchParams.get('gitPath')

  if (!gitTargetId || !branch || !gitPath) {
    return json(res, 400, {
      error: 'gitTargetId, branch and gitPath are required',
    })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })
  const caller = await resolveCallerIdentity(req)
  if (
    !caller?.isAdmin &&
    conn.owner_id !== (caller?.userId || '_unknown') &&
    !conn.shared
  ) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }

  try {
    const content = await fetchFile(conn.payload, branch, gitPath)
    if (!content) return json(res, 404, { error: 'Manifest not found' })

    const docs = yaml.loadAll(content)
    const { container } = findDeploymentContainer(docs)
    const env = (container?.env || [])
      .filter((e) => e && typeof e.name === 'string' && e.value !== undefined)
      .map((e) => ({ key: e.name, value: String(e.value) }))

    return json(res, 200, { env })
  } catch (err) {
    console.error('[vibe manifest-env error]', err.message || err)
    return json(res, 500, { error: err.message || 'Failed to read manifest' })
  }
}

/**
 * POST /api/vibe/update-env
 * Body: { gitTargetId, branch, gitPath, envVars: [{ key, value }] }
 *
 * Fetches the committed manifest, rewrites the application container's env
 * array, and regenerates the vibe-env init container so the .env file written
 * into the volume stays in sync. Portainer reconciles on the next poll cycle.
 */
async function handleVibeUpdateEnv(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { gitTargetId, branch, gitPath, envVars, envId, ns } = data
  if (!gitTargetId || !branch || !gitPath) {
    return json(res, 400, {
      error: 'gitTargetId, branch and gitPath are required',
    })
  }
  if (!Array.isArray(envVars)) {
    return json(res, 400, {
      error: 'envVars must be an array of { key, value }',
    })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })
  const caller = await resolveCallerIdentity(req)
  if (
    !caller?.isAdmin &&
    conn.owner_id !== (caller?.userId || '_unknown') &&
    !conn.shared
  ) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }

  try {
    const content = await fetchFile(conn.payload, branch, gitPath)
    if (!content)
      return json(res, 404, { error: 'Manifest file not found in git' })

    const docs = yaml.loadAll(content)
    const { deployment, container, podSpec } = findDeploymentContainer(docs)
    if (!deployment || !container) {
      return json(res, 404, {
        error: 'No Deployment container found in manifest',
      })
    }

    // Normalise the incoming variables (drop blank keys, coerce values to string).
    const cleaned = envVars
      .filter((v) => v && typeof v.key === 'string' && v.key.trim())
      .map((v) => ({ key: v.key.trim(), value: String(v.value ?? '') }))

    // Split into plaintext (committed) and sensitive (Secret-backed). See #38.
    const { plain: plainEnv, sensitive: sensitiveEnv } =
      splitSensitiveEnv(cleaned)
    const safeApp = sanitizeStackName(deployment.metadata?.name || 'app')
    const secretForApp = `${safeApp}-app-secrets`

    // 1. Container env array: plaintext inline, sensitive via secretKeyRef.
    //    Preserve runtime-managed dep-path vars (PYTHONPATH/PATH/GEM_*/BUNDLE_*)
    //    already present on the container, so an env edit does not strip the
    //    interpreter's ability to find PV-installed dependencies.
    const RUNTIME_ENV_NAMES = new Set([
      'PYTHONPATH',
      'PATH',
      'BUNDLE_PATH',
      'BUNDLE_GEMFILE',
      'GEM_HOME',
      'GEM_PATH',
    ])
    const preservedRuntimeEnv = (
      Array.isArray(container.env) ? container.env : []
    ).filter((e) => e && RUNTIME_ENV_NAMES.has(e.name) && e.value !== undefined)

    const userNextEnv = [
      ...plainEnv.map((v) => ({ name: v.key, value: v.value })),
      ...sensitiveEnv.map((v) => ({
        name: v.key,
        valueFrom: { secretKeyRef: { name: secretForApp, key: v.key } },
      })),
    ]
    // Merge by name, runtime-managed vars winning on collision, no duplicates.
    const nextByName = new Map()
    for (const e of userNextEnv) nextByName.set(e.name, e)
    for (const e of preservedRuntimeEnv) nextByName.set(e.name, e)
    const nextEnv = [...nextByName.values()]
    if (nextEnv.length > 0) {
      container.env = nextEnv
    } else {
      delete container.env
    }

    // 2. vibe-env init container — writes ONLY the plaintext vars into .env.
    //    Sensitive values arrive via secretKeyRef and never touch the manifest.
    const workDir = container.workingDir || '/app'
    podSpec.initContainers = (podSpec.initContainers || []).filter(
      (c) => c.name !== 'vibe-env',
    )
    if (plainEnv.length > 0) {
      const envFileContent = plainEnv
        .map((v) => `${v.key}=${v.value.replace(/\n/g, '\\n')}`)
        .join('\n')
      const escaped = envFileContent.replace(/'/g, "'\\''")
      podSpec.initContainers.push(
        harden({
          name: 'vibe-env',
          image: 'busybox:1.36',
          command: ['sh', '-c', `printf '%s' '${escaped}' > ${workDir}/.env`],
          resources: INIT_ENV_RESOURCES,
          volumeMounts: [{ name: 'app-data', mountPath: workDir }],
        }),
      )
    }
    if (podSpec.initContainers.length === 0) delete podSpec.initContainers

    // 3. Create/replace the app-secrets Secret when we have a live target.
    //    Without envId/ns we can only commit the manifest; the secretKeyRef will
    //    resolve once the Secret exists, so we surface a clear warning.
    let secretWarning = null
    if (sensitiveEnv.length > 0) {
      if (envId && ns) {
        await createKubernetesSecret(req, {
          envId,
          ns,
          name: secretForApp,
          data: Object.fromEntries(
            sensitiveEnv.map((v) => [v.key, String(v.value ?? '')]),
          ),
        })
      } else {
        secretWarning =
          'Sensitive variables were referenced as secrets in the manifest but the Secret ' +
          'could not be created (no environment/namespace context). Create it manually or ' +
          're-save from the app detail view.'
      }
    }

    const updatedYaml = serializeManifests(docs)

    await commitFiles(
      conn.payload,
      branch,
      `vibe: update environment variables for ${safeApp}`,
      [{ path: gitPath, content: updatedYaml }],
    )

    return json(res, 200, {
      ok: true,
      ...(secretWarning ? { warning: secretWarning } : {}),
    })
  } catch (err) {
    console.error('[vibe update-env error]', err.message || err)
    return json(res, 500, { error: err.message || 'Update failed' })
  }
}

// ---------------------------------------------------------------------------
// Manifest / source deletion (app removal)
// ---------------------------------------------------------------------------

/**
 * POST /api/vibe/delete-manifest
 * Body: { gitTargetId, branch, gitPath, appName }
 *
 * Removes a committed manifest file or source directory from git when an
 * application is deleted. Paths ending in an extension are treated as files;
 * extensionless paths (source directories) are removed recursively.
 */
async function handleVibeDeleteManifest(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { gitTargetId, branch, appName } = data

  // New form: an array of paths (files and/or directories) removed atomically
  // in a single commit. Preferred by the delete flow to avoid a non-fast-forward
  // race between separate file and directory commits.
  const rawPaths = Array.isArray(data.paths) ? data.paths : null
  const gitPath = sanitizeGitPath(data.gitPath)

  if (!gitTargetId || !branch || (!rawPaths && !gitPath)) {
    return json(res, 400, {
      error: 'gitTargetId, branch and (paths or gitPath) are required',
    })
  }

  const conn = getConnectionById(gitTargetId)
  if (!conn) return json(res, 404, { error: 'Git target not found' })
  const caller = await resolveCallerIdentity(req)
  if (
    !caller?.isAdmin &&
    conn.owner_id !== (caller?.userId || '_unknown') &&
    !conn.shared
  ) {
    return json(res, 403, { error: 'Forbidden — git target not accessible' })
  }

  try {
    if (rawPaths) {
      const paths = rawPaths.map((p) => sanitizeGitPath(p)).filter(Boolean)
      if (paths.length === 0)
        return json(res, 400, { error: 'No valid paths provided' })
      await deletePaths(
        conn.payload,
        branch,
        paths,
        `remove: ${appName || paths.join(', ')}`,
      )
      return json(res, 200, { ok: true })
    }

    // Legacy single-path form (file or directory).
    // Paths without an extension are source directories; paths with an
    // extension (.yaml/.yml) are manifest files.
    const isDirectory = !gitPath.match(/\.[a-zA-Z0-9]+$/)
    if (isDirectory) {
      await deleteDirectory(
        conn.payload,
        branch,
        gitPath,
        `remove: ${appName || gitPath}`,
      )
    } else {
      await deleteFile(
        conn.payload,
        branch,
        gitPath,
        `remove: ${appName || gitPath}`,
      )
    }
    return json(res, 200, { ok: true })
  } catch (err) {
    console.error('[vibe delete-manifest error]', err.message || err)
    return json(res, 502, { error: err.message || 'Delete failed' })
  }
}

/**
 * Delete the Portainer stack that owns an app, which tears down every resource
 * declared in its manifest (Deployment, Service, Ingress, PVC).
 *
 * This is the counterpart to createPortainerGitOpsStack. Deleting only the
 * Kubernetes resources used to leave the stack record behind, still polling git
 * on its auto-update interval: because that poll compares the branch head
 * against the stack's last deployed commit, the next deploy of any *other* app
 * moved the shared manifests branch and the orphaned stack re-applied the
 * manifest of the app that had been deleted.
 *
 * `external=false` is required — `external=true` means "external Swarm stack"
 * and takes an entirely different code path. `endpointId` is mandatory.
 */
async function handleVibeDeleteStack(req, res) {
  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { envId, stackId } = data
  if (!envId || !stackId) {
    return json(res, 400, { error: 'envId and stackId are required' })
  }
  // Portainer stamps the id on the resource as a string label; keep it numeric
  // so a malformed value can't be interpolated into the request path.
  const numericStackId = parseInt(String(stackId), 10)
  const numericEnvId = parseInt(String(envId), 10)
  if (!Number.isInteger(numericStackId) || numericStackId <= 0) {
    return json(res, 400, { error: `Invalid stackId: ${stackId}` })
  }
  if (!Number.isInteger(numericEnvId) || numericEnvId <= 0) {
    return json(res, 400, { error: `Invalid envId: ${envId}` })
  }

  const target = resolvePortainerTarget()
  if (!target)
    return json(res, 502, { error: 'Cannot resolve Portainer target' })

  try {
    await portainerRequest(
      target,
      extractToken(req),
      'DELETE',
      `/api/stacks/${numericStackId}?endpointId=${numericEnvId}&external=false`,
    )
    return json(res, 200, { ok: true })
  } catch (err) {
    // 404 means the stack is already gone — the caller's goal is met.
    if (err?.status === 404)
      return json(res, 200, { ok: true, alreadyGone: true })
    console.error('[vibe delete-stack error]', {
      message: err?.message || String(err),
      status: err?.status,
      stackId: numericStackId,
      envId: numericEnvId,
    })
    return json(res, 502, {
      error: err?.message || 'Stack deletion failed',
      status: err?.status || null,
    })
  }
}
