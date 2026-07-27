import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { Alert } from '@ds/v3-components/Alert/Alert'
import { Button } from '@ds/v3-components/Button/Button'
import type { FileNode } from '@ds/v3-components/FilePicker/FilePicker'
import { MultiStepWizard } from '@ds/v3-templates/MultiStepWizard/MultiStepWizard'
import type {
  WizardContext,
  WizardStep,
} from '@ds/v3-templates/MultiStepWizard/MultiStepWizard'
import { PageTitle } from '@ds/v3-templates/PageTitle/PageTitle'

import { ROUTES } from '../../lib/routes.js'
import { listGitTargets, listRepoDir } from '../../lib/gitTargets.js'
import { dirEntriesToNodes } from './gitRepoTree'
import {
  useAppStore,
  visibleEnvironments,
  isEnvDisabled,
} from '../../store/useAppStore.js'
import { serverFetch, kubeFetch } from '../../lib/api.js'
import { fetchNamespaceOptions } from '../../lib/deployK8s.js'
import { checkEnvPermissions } from '../../lib/envPermissions.js'
import { checkIngress, checkLoadBalancer } from '../../lib/readinessChecks.js'
import {
  manualRefresh,
  schedulePostDeployRefreshes,
} from '../../services/refreshDeployments.js'
import { stripCommonRoot, type UploadedFile } from '../../lib/fileIntake'
import { GitOpsStepFields, useGitOpsSelection } from './GitOpsStep'
import type { GitOpsSelection } from './GitOpsStep'
import { detectRuntime, type RuntimeDef } from './runtimes'
import { parseEnvExample, type EnvVar } from './envExample'
import {
  STARTUP_POLL_MS,
  STARTUP_TIMEOUT_MS,
  isBlockingReason,
  sanitizeAppName,
  type StartupPhase,
} from './startup'
import { FilesStep } from './FilesStep'
import { DetailsStep, type EnvCapabilities } from './DetailsStep'
import { SettingsStep } from './SettingsStep'
import { StartupPanel } from './StartupPanel'
import { errMessage } from '../../lib/errors'
import type { Environment } from '../../types/environment'
import type { GitTarget } from '../../types/gitTarget'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeployIngress {
  host: string
  path: string
  port: number
  ingressClass: string
}

interface VibeParams {
  runtime: string
  runtimeImage: string
  startCmd: string
  workDir: string
  envVars: { key: string; value: string }[]
  sourceType: string
  sourceFiles: { path: string; content: string }[]
  gitSource: { gitTargetId: string; branch: string; path: string } | null
}

/**
 * The fully-assembled deploy request built once the wizard's config step is
 * confirmed. Pass-through collections (container/volume specs) are `unknown[]`
 * because they are only forwarded to the server, never read on the client.
 */
interface DeployStagedParams {
  appName: string
  ns: string
  envId: string
  envName: string
  instances: number
  containerSpecs: unknown[]
  containerRowIds: string[]
  volumeDefs: unknown[]
  exposeType: string
  servicePorts: number[]
  ingress: DeployIngress
  vibeParams: VibeParams
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function VibeDeploy() {
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const environments = useAppStore((s) => visibleEnvironments(s))
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const envPermissions = useAppStore((s) => s.envPermissions)
  const patchEnvPermissions = useAppStore((s) => s.patchEnvPermissions)
  const pushToast = useAppStore((s) => s.pushToast)
  const [ingressHostMap, setIngressHostMap] = useState<Record<string, string>>(
    {},
  )

  // Wizard navigation is owned by MultiStepWizard; keep the latest context so
  // async handlers (deploy success, file resets) can navigate too.
  const ctxRef = useRef<WizardContext | null>(null)

  const [noGitTargets, setNoGitTargets] = useState(false)
  const [gitTargetsList, setGitTargetsList] = useState<GitTarget[]>([])
  // Gate the Storage step on this so the stepper settles into its final shape
  // once, instead of showing Storage on first paint (empty list) and then
  // dropping it after the fetch resolves with a single target (layout shift).
  const [gitTargetsLoaded, setGitTargetsLoaded] = useState(false)
  useEffect(() => {
    listGitTargets()
      .then((r) => {
        const list = (r?.connections || []) as GitTarget[]
        setNoGitTargets(list.length === 0)
        setGitTargetsList(list)
      })
      .catch(() => {})
      .finally(() => setGitTargetsLoaded(true))
  }, [])

  // ---- Step 1: files or git source ----
  const [sourceType, setSourceType] = useState('upload') // 'upload' | 'git'
  const [files, setFiles] = useState<UploadedFile[]>([])
  // Git source fields
  const [gitSourceTargetId, setGitSourceTargetId] = useState('')
  const [gitSourceBranch, setGitSourceBranch] = useState('main')
  // Subfolder chosen in the file picker — becomes gitSource.path at deploy time.
  const [gitSourcePath, setGitSourcePath] = useState('')
  const [gitSourceBranches, setGitSourceBranches] = useState<string[]>([])
  const [gitSourceConfirmed, setGitSourceConfirmed] = useState(false)

  // ---- Step 2: runtime ----
  const [detectedRuntime, setDetectedRuntime] = useState<RuntimeDef | null>(
    null,
  )
  const [startCmd, setStartCmd] = useState('')
  const [, setRuntimeConfirmed] = useState(false)

  // ---- Step 3: env vars ----
  const [envVars, setEnvVars] = useState<EnvVar[]>([])
  const [, setEnvVarsConfirmed] = useState(false)
  const hasEnvExample = files.some(
    (f) => f.name === '.env.example' || f.name.endsWith('.env.example'),
  )

  // ---- Step 4: deploy config ----
  const [appName, setAppName] = useState('')
  const [envId, setEnvId] = useState('')
  const [nsList, setNsList] = useState<string[]>([])
  const [nsLoading, setNsLoading] = useState(false)
  const [namespace, setNamespace] = useState('')
  const [manualNs, setManualNs] = useState(false)
  const [manualNsValue, setManualNsValue] = useState('')
  const [nsHint, setNsHint] = useState({ text: '', tone: 'dim' })
  const instances = 1
  const [exposeType, setExposeType] = useState('Ingress')
  const [svcPort] = useState('')
  const [ingHost, setIngHost] = useState('')
  const [ingPath] = useState('/')
  const [ingClass, setIngClass] = useState('')
  const [, setDeployConfigConfirmed] = useState(false)

  // ---- Env capabilities (for expose type filtering) ----
  // null = not yet probed, true = available, false = not available
  const [envCapabilities, setEnvCapabilities] = useState<EnvCapabilities>({
    ingressOk: null,
    lbOk: null,
    probing: false,
    ingressClasses: [],
    defaultIngressClass: null,
  })

  // ---- Step 5: gitops (stagedParams) ----
  const [stagedParams, setStagedParams] = useState<DeployStagedParams | null>(
    null,
  )
  const [deploying, setDeploying] = useState(false)
  const gitOps = useGitOpsSelection()

  // ---- Startup progress (final step) ----
  const [startupPhase, setStartupPhase] = useState<StartupPhase | null>(null)
  const [startupReason, setStartupReason] = useState<string | null>(null)
  const [startupUrl, setStartupUrl] = useState<string | null>(null)
  const [startupErrorMsg, setStartupErrorMsg] = useState<string | null>(null)
  const [startupFailStage, setStartupFailStage] = useState<
    'deploy' | 'start' | null
  >(null)
  // Cancels the poll loop on unmount / navigation; sp used by "keep waiting".
  const startupCancelRef = useRef(false)
  const startupSpRef = useRef<DeployStagedParams | null>(null)

  useEffect(() => {
    return () => {
      startupCancelRef.current = true
    }
  }, [])

  const resolvedNs = manualNs ? manualNsValue.trim() : namespace
  const permKey = envId && resolvedNs ? `${envId}:${resolvedNs}` : null
  const perms = permKey ? envPermissions[permKey] || null : null
  // Vibe Deploy always creates a PVC — check both
  const canProceed = !perms || (perms.canDeploy && perms.canCreatePvc)

  // ---- Effects ----

  // Permission check when env + ns are both set
  useEffect(() => {
    if (!envId || !resolvedNs || !token) return
    const key = `${envId}:${resolvedNs}`
    if (envPermissions[key] !== undefined) return
    checkEnvPermissions(token, envId, resolvedNs)
      .then((p) => {
        patchEnvPermissions(envId, resolvedNs, p)
      })
      .catch(() => {
        /* silent — default is permissive */
      })
  }, [envId, resolvedNs, token, envPermissions, patchEnvPermissions])

  // Auto-detect runtime for uploaded files. This must also re-run when the user
  // toggles the source type back to "upload": switching tabs clears
  // detectedRuntime, and since the files array itself is unchanged the runtime
  // would otherwise stay null and deploy would fall back to node:22 — e.g. a
  // static HTML upload would wrongly run in the Node container. Git detection is
  // owned by handleGitFolderSelect, so skip while on the git tab.
  useEffect(() => {
    if (sourceType !== 'upload') return
    if (!files.length) {
      setDetectedRuntime(null)
      setStartCmd('')
      setRuntimeConfirmed(false)
      return
    }
    const rt = detectRuntime(files)
    setDetectedRuntime(rt)
    if (rt) setStartCmd(rt.defaultCmd(files))
    setRuntimeConfirmed(false)
  }, [files, sourceType])

  // Auto-detect env vars when files change
  useEffect(() => {
    const envFile = files.find(
      (f) => f.name === '.env.example' || f.name.endsWith('.env.example'),
    )
    if (envFile) {
      setEnvVars(parseEnvExample(envFile.text))
    } else {
      setEnvVars([])
    }
    setEnvVarsConfirmed(false)
  }, [files])

  // Reset the folder selection whenever the target or branch changes. The
  // folder picker (GitFolderTree) lazily loads directories on demand, so no
  // repository preloading happens here — only the chosen folder is cleared.
  useEffect(() => {
    setGitSourceConfirmed(false)
    setGitSourcePath('')
    setDetectedRuntime(null)
  }, [sourceType, gitSourceTargetId, gitSourceBranch])

  // Fetch a single directory level for the folder picker. Called by
  // GitFolderTree the first time the root or a folder is expanded.
  const loadGitDir = useCallback(
    async (path: string): Promise<FileNode[]> => {
      const data: { files?: { path: string; type: 'file' | 'dir' }[] } =
        await listRepoDir(gitSourceTargetId, gitSourceBranch.trim(), path)
      return dirEntriesToNodes(path, data.files || [])
    },
    [gitSourceTargetId, gitSourceBranch],
  )

  // Auto-derive app name from file list
  useEffect(() => {
    if (appName) return
    const pkgFile = files.find((f) => f.name === 'package.json')
    if (pkgFile) {
      try {
        const parsed = JSON.parse(pkgFile.text)
        if (parsed?.name) {
          setAppName(
            parsed.name
              .replace(/[^a-z0-9-]/gi, '-')
              .toLowerCase()
              .slice(0, 40),
          )
          return
        }
      } catch {
        /* ignore */
      }
    }
    // fallback to a slug from first meaningful file
    const mainFile = files.find((f) =>
      ['server.js', 'app.py', 'main.py', 'app.rb', 'index.php'].includes(
        f.name,
      ),
    )
    if (mainFile) {
      setAppName(
        mainFile.name
          .replace(/\.[^.]+$/, '')
          .replace(/[^a-z0-9-]/gi, '-')
          .toLowerCase(),
      )
    }
  }, [files]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select environment when only one is available
  useEffect(() => {
    if (envId) return
    const available = environments.filter(
      (e: Environment) => !isEnvDisabled({ disabledEnvs }, e.Id),
    )
    if (available.length === 1) {
      setEnvId(String(available[0].Id))
    }
  }, [environments, disabledEnvs]) // eslint-disable-line react-hooks/exhaustive-deps

  // Probe env capabilities when envId changes (for expose type filtering)
  useEffect(() => {
    if (!envId || !token) {
      setEnvCapabilities({
        ingressOk: null,
        lbOk: null,
        probing: false,
        ingressClasses: [],
        defaultIngressClass: null,
      })
      return
    }
    setEnvCapabilities({
      ingressOk: null,
      lbOk: null,
      probing: true,
      ingressClasses: [],
      defaultIngressClass: null,
    })
    Promise.all([checkIngress(token, envId), checkLoadBalancer(token, envId)])
      .then(([ingressResult, lbResult]) => {
        const defaultClass =
          ingressResult.defaultClass ||
          (ingressResult.classes?.length === 1
            ? ingressResult.classes[0].name
            : null)
        const caps = {
          ingressOk: ingressResult.ok !== false,
          lbOk: lbResult.ok !== false,
          probing: false,
          ingressClasses: ingressResult.classes || [],
          defaultIngressClass: defaultClass,
        }
        setEnvCapabilities(caps)
        // Exposure is always via a URL through the cluster ingress controller.
        setExposeType('Ingress')
        // Auto-populate ingress class from cluster default
        if (defaultClass) setIngClass(defaultClass)
      })
      .catch(() => {
        // On error, show all options (permissive fallback)
        setEnvCapabilities({
          ingressOk: true,
          lbOk: true,
          probing: false,
          ingressClasses: [],
          defaultIngressClass: null,
        })
      })
  }, [envId, token])

  // Fetch ingresses already deployed in the selected namespace to derive the base domain per class.
  // Admin-configured ingresses (no managed-by=portainer-run label) are used as-is — their host IS
  // the base domain. App-deployed ingresses (managed-by=portainer-run) have host={appName}.{base},
  // so we strip the first segment. Admin ingresses take priority; managed ones are the fallback.
  useEffect(() => {
    if (!envId || !resolvedNs || !token) {
      setIngressHostMap({})
      return
    }
    kubeFetch(
      token,
      envId,
      `/apis/networking.k8s.io/v1/namespaces/${resolvedNs}/ingresses`,
    )
      .then(async (r: Response) => {
        if (!r.ok) {
          setIngressHostMap({})
          return
        }
        const data = await r.json()
        const items = data.items || []
        const adminIngresses = items.filter(
          (item: { metadata?: { labels?: Record<string, string> } }) =>
            item.metadata?.labels?.['managed-by'] !== 'portainer-run',
        )
        // Prefer admin-configured ingresses as the source of truth.
        // Fall back to managed ingresses only if no admin ones exist yet.
        const sources = adminIngresses.length > 0 ? adminIngresses : items
        const usingManaged = adminIngresses.length === 0
        const map: Record<string, string> = {}
        for (const item of sources) {
          const cls =
            item.spec?.ingressClassName ||
            item.metadata?.annotations?.['kubernetes.io/ingress.class'] ||
            ''
          let host = item.spec?.rules?.[0]?.host || ''
          // Managed ingresses have host={appName}.{baseDomain} — strip the app prefix
          if (usingManaged && host.includes('.')) {
            host = host.substring(host.indexOf('.') + 1)
          }
          if (cls && host) map[cls] = host
        }
        setIngressHostMap(map)
      })
      .catch(() => setIngressHostMap({}))
  }, [envId, resolvedNs, token])

  // Re-derive ingress host when appName or active ingress class changes
  useEffect(() => {
    if (exposeType !== 'Ingress' || !appName) return
    const base = ingressHostMap[ingClass] || ''
    if (base) setIngHost(`${appName}.${base}`)
  }, [appName, exposeType, ingClass, ingressHostMap])

  useEffect(() => {
    if (!envId || !token) {
      setNsList([])
      setNamespace('')
      setManualNs(false)
      setNsHint({ text: '', tone: 'dim' })
      return
    }
    setNsLoading(true)
    setNsList([])
    setNamespace('')
    fetchNamespaceOptions(token, envId)
      .then((r) => {
        if (r.ok) {
          if (r.manual) {
            setManualNs(true)
            setNsHint({
              text: 'Enter your project space name below',
              tone: 'warn',
            })
          } else {
            setNsList(r.namespaces)
            setManualNs(false)
            // Auto-select when only one project space is available
            if (r.namespaces.length === 1) {
              setNamespace(r.namespaces[0])
            } else {
              setNamespace('')
            }
            setNsHint({
              text: `${r.namespaces.length} project space${r.namespaces.length !== 1 ? 's' : ''} found`,
              tone: 'ok',
            })
          }
        } else {
          setManualNs(true)
          setNsHint({
            text: r.error || 'Could not load project spaces',
            tone: 'err',
          })
        }
      })
      .catch(() => {
        setManualNs(true)
        setNsHint({ text: 'Could not load project spaces', tone: 'err' })
      })
      .finally(() => setNsLoading(false))
  }, [envId, token])

  // ---- Handlers ----

  function goTo(stepId: string) {
    ctxRef.current?.goTo(stepId)
  }

  function handleFilesAdded(newFiles: UploadedFile[]) {
    const stripped = stripCommonRoot(newFiles)
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.webkitRelativePath || f.name))
      const merged = [...prev]
      for (const f of stripped) {
        const key = f.webkitRelativePath || f.name
        if (!existing.has(key)) {
          merged.push(f)
          existing.add(key)
        }
      }
      return merged
    })
    setRuntimeConfirmed(false)
    setEnvVarsConfirmed(false)
    setDeployConfigConfirmed(false)
    setStagedParams(null)
    goTo('files')
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
    setRuntimeConfirmed(false)
    setEnvVarsConfirmed(false)
    setDeployConfigConfirmed(false)
    setStagedParams(null)
    goTo('files')
  }

  function resetFiles() {
    setFiles([])
    setRuntimeConfirmed(false)
    setEnvVarsConfirmed(false)
    setDeployConfigConfirmed(false)
    setStagedParams(null)
  }

  function confirmFiles(ctx: WizardContext) {
    if (sourceType === 'upload') {
      if (!files.length) {
        pushToast('Add at least one file', 'err')
        return
      }
      ctx.goTo(hasEnvExample ? 'settings' : 'details')
    } else {
      // git source — a subfolder must be chosen in the file picker first
      if (!gitSourceConfirmed) {
        pushToast('Select the folder that contains your app', 'err')
        return
      }
      ctx.goTo(hasEnvExample ? 'settings' : 'details')
    }
  }

  // Select a single folder as the app root and detect its runtime. The folder's
  // immediate files are fetched on demand (not preloaded) and detection runs on
  // their base names, so markers like requirements.txt / package.json match at
  // the folder root.
  async function handleGitFolderSelect(folderPath: string) {
    setGitSourcePath(folderPath)
    setGitSourceConfirmed(true)
    setDetectedRuntime(null)
    try {
      const data: { files?: { path: string; type: 'file' | 'dir' }[] } =
        await listRepoDir(gitSourceTargetId, gitSourceBranch.trim(), folderPath)
      const syntheticFiles = (data.files || [])
        .filter((f) => f.type === 'file')
        .map((f) => ({ name: f.path, text: '' }))
      const rt = detectRuntime(syntheticFiles)
      setDetectedRuntime(rt)
      setStartCmd(rt.defaultCmd(syntheticFiles))
    } catch {
      // Runtime detection is best-effort; deploy still falls back to defaults.
    }
  }

  async function loadGitSourceBranches(targetId: string) {
    if (!targetId) return
    try {
      const r = await serverFetch(`/api/connections/${targetId}/branches`)
      const data = await r.json().catch(() => ({}))
      setGitSourceBranches(data.branches || [])
    } catch {
      setGitSourceBranches([])
    }
  }

  function confirmEnvVars(ctx: WizardContext) {
    setEnvVarsConfirmed(true)
    ctx.goTo('details')
  }

  function confirmDeployConfig(ctx: WizardContext) {
    if (!appName.trim()) {
      pushToast('App name is required', 'err')
      return
    }
    if (perms && !perms.canDeploy) {
      pushToast('No deploy permission in this project space', 'err')
      return
    }
    if (perms && !perms.canCreatePvc) {
      pushToast(
        'No permission to create PersistentVolumeClaims in this project space',
        'err',
      )
      return
    }
    if (!envId) {
      pushToast('Select a target environment', 'err')
      return
    }
    if (!resolvedNs) {
      pushToast('Select or enter a project space', 'err')
      return
    }

    // Build deploy params for GitOpsStep dry-run + actual deploy
    // Priority: user-entered svcPort > PORT env var > runtime default
    // Normalise env vars once: trim names (a stray space is an invalid
    // Kubernetes env-var name and would also break the PORT lookup below) and
    // drop blanks. Values are left as-typed.
    // Strip the client-only `id` used for stable React keys; the server only
    // consumes { key, value }.
    const cleanEnvVars = envVars
      .map(({ id: _id, ...v }) => ({ ...v, key: v.key.trim() }))
      .filter((v) => v.key)

    const portEnvVar = cleanEnvVars.find((v) => v.key === 'PORT')?.value
    const portValue = parseInt(
      String(svcPort || portEnvVar || detectedRuntime?.port || 80),
      10,
    )
    const resolvedPort = isNaN(portValue) ? 80 : portValue

    // Build a single-container spec representing the vibe deploy
    const containerSpec = {
      name: appName,
      image: detectedRuntime?.image || 'node:22',
      command: startCmd ? startCmd.split(/\s+/) : undefined,
      workingDir: detectedRuntime?.workDir || '/app',
      ports: [{ containerPort: resolvedPort, protocol: 'TCP' }],
      env: cleanEnvVars.map((v) => ({ name: v.key, value: v.value })),
    }

    const params: DeployStagedParams = {
      appName: appName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-'),
      ns: resolvedNs,
      envId,
      envName:
        environments.find((e: Environment) => String(e.Id) === String(envId))
          ?.Name || String(envId),
      instances,
      containerSpecs: [containerSpec],
      containerRowIds: ['vibe-0'],
      volumeDefs: [
        {
          name: `${appName}-data`,
          size: '1Gi',
          mountPath: detectedRuntime?.workDir || '/app',
          containerId: 'vibe-0',
          storageClass: '',
          // Vibe deploy marker — server uses this to generate init container
          vibeSource: true,
        },
      ],
      exposeType: exposeType,
      servicePorts: [resolvedPort],
      ingress: {
        host: ingHost.trim(),
        path: ingPath || '/',
        port: resolvedPort,
        ingressClass: ingClass.trim(),
      },
      // Vibe-specific extras passed through to server
      vibeParams: {
        runtime: detectedRuntime?.id || 'node',
        runtimeImage: detectedRuntime?.image || 'node:22',
        startCmd: startCmd.trim(),
        workDir: detectedRuntime?.workDir || '/app',
        envVars: cleanEnvVars,
        sourceType,
        // Upload source
        sourceFiles:
          sourceType === 'upload'
            ? files.map((f) => ({
                path: f.webkitRelativePath || f.name,
                content: f.text,
              }))
            : [],
        // Git source
        gitSource:
          sourceType === 'git'
            ? {
                gitTargetId: gitSourceTargetId,
                branch: gitSourceBranch.trim(),
                path: gitSourcePath.trim(),
              }
            : null,
      },
    }

    setStagedParams(params)
    setDeployConfigConfirmed(true)
    if (gitTargetsList.length === 1) {
      const target = gitTargetsList[0]
      void handleGitOpsConfirm(
        {
          gitTargetId: target.id,
          branch: target.payload?.defaultBranch || 'main',
          pathPrefix: target.payload?.pathPrefix || '',
          pollInterval: '5m',
        },
        params,
      )
    } else {
      ctx.goTo('storage')
    }
  }

  async function handleGitOpsConfirm(
    { gitTargetId, branch, pathPrefix, pollInterval }: GitOpsSelection,
    _params: DeployStagedParams | null = null,
  ) {
    const sp = _params || stagedParams
    if (!sp) return
    setDeploying(true)
    // Advance to the final "Deploy" step, which renders the startup Timeline.
    ctxRef.current?.goTo('deploy')
    startupCancelRef.current = false
    startupSpRef.current = sp
    setStartupReason(null)
    setStartupUrl(null)
    setStartupErrorMsg(null)
    setStartupFailStage(null)
    setStartupPhase('deploying')
    try {
      const res = await serverFetch('/api/vibe/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gitTargetId,
          branch,
          pathPrefix,
          pollInterval,
          envId: sp.envId,
          envName: sp.envName,
          vibeParams: sp.vibeParams,
          deployParams: {
            appName: sp.appName,
            ns: sp.ns,
            instances: sp.instances,
            containerSpecs: sp.containerSpecs,
            containerRowIds: sp.containerRowIds,
            volumeDefs: sp.volumeDefs,
            exposeType: sp.exposeType,
            servicePorts: sp.servicePorts,
            ingress: sp.ingress,
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      // Deploy accepted — now wait for the app to actually come up. Kick off the
      // background cache refreshes so the Applications list is warm once we finish.
      schedulePostDeployRefreshes()
      setStartupPhase('starting')
      void waitForAppReady(sp)
    } catch (e) {
      const msg = errMessage(e) || 'Unknown error'
      setStartupErrorMsg(msg)
      setStartupFailStage('deploy')
      setStartupPhase('error')
      pushToast('Deploy failed: ' + msg, 'err')
    } finally {
      setDeploying(false)
    }
  }

  // Poll Kubernetes (via Portainer) until the app's pods are ready, surfacing a
  // friendly status while it boots. Stops on ready, a blocking error, cancel, or
  // timeout.
  async function waitForAppReady(sp: DeployStagedParams) {
    const safeApp = sanitizeAppName(sp.appName)
    const deadline = Date.now() + STARTUP_TIMEOUT_MS

    while (!startupCancelRef.current && Date.now() < deadline) {
      let reason: string | null = null
      let url: string | null = null
      try {
        const r = await serverFetch(
          `/env-status/${sp.envId}?ns=${encodeURIComponent(sp.ns)}`,
        )
        if (r.ok) {
          const j = await r.json()
          const info = j?.data?.[safeApp]
          reason = info?.statusReason ?? null
          url = info?.accessUrl ?? null
        }
      } catch {
        /* transient — keep polling */
      }

      let ready = false
      try {
        const dr = await kubeFetch(
          token,
          sp.envId,
          `/apis/apps/v1/namespaces/${sp.ns}/deployments/${safeApp}`,
        )
        if (dr.ok) {
          const dep = await dr.json()
          const readyReplicas = dep?.status?.readyReplicas || 0
          const desired = dep?.spec?.replicas ?? 0
          ready = desired > 0 && readyReplicas >= desired
        }
      } catch {
        /* transient — keep polling */
      }

      if (startupCancelRef.current) return

      if (ready) {
        setStartupUrl(url)
        setStartupReason(null)
        setStartupPhase('ready')
        void manualRefresh()
        pushToast(`${sp.appName} is up and running`, 'ok')
        return
      }

      if (isBlockingReason(reason)) {
        setStartupReason(reason)
        setStartupFailStage('start')
        setStartupPhase('error')
        return
      }

      setStartupReason(reason)
      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS))
    }

    if (!startupCancelRef.current) {
      setStartupPhase('timeout')
    }
  }

  // Clear all deploy form state — used after the flow completes or is abandoned.
  function resetDeployForm() {
    startupCancelRef.current = true
    setStartupPhase(null)
    setStartupReason(null)
    setStartupUrl(null)
    setStartupErrorMsg(null)
    setStartupFailStage(null)
    setFiles([])
    setStagedParams(null)
    setRuntimeConfirmed(false)
    setEnvVarsConfirmed(false)
    setDeployConfigConfirmed(false)
    setAppName('')
    setEnvId('')
    setNamespace('')
    setExposeType('Ingress')
    setIngHost('')
    setIngClass('')
    goTo('files')
  }

  function finishToServices() {
    resetDeployForm()
    navigate(ROUTES.services)
  }

  function resumeWaiting() {
    if (!startupSpRef.current) return
    startupCancelRef.current = false
    setStartupPhase('starting')
    void waitForAppReady(startupSpRef.current)
  }

  // ---- Wizard steps (dynamic: settings only with .env.example, storage only
  // when the user must choose between multiple git targets). The final "Deploy"
  // step hosts the startup Timeline — configuration lives on the "Details" step. ----

  const wizardSteps: WizardStep[] = [
    { id: 'files', label: 'Files' },
    ...(hasEnvExample ? [{ id: 'settings', label: 'App settings' }] : []),
    { id: 'details', label: 'Details' },
    ...(gitTargetsLoaded && gitTargetsList.length !== 1
      ? [{ id: 'storage', label: 'Storage' }]
      : []),
    { id: 'deploy', label: 'Deploy' },
  ]

  const nsStatusColor =
    nsHint.tone === 'warn'
      ? 'var(--status-warning, #f79009)'
      : nsHint.tone === 'ok'
        ? 'var(--status-success, #17b26a)'
        : nsHint.tone === 'err'
          ? 'var(--status-danger, #f04438)'
          : 'var(--muted)'

  // ---- Step content renderers ----

  function renderStorageStep() {
    if (!stagedParams) return null
    return (
      <GitOpsStepFields
        state={gitOps}
        appName={stagedParams.appName}
        ns={stagedParams.ns}
        sectionTitle="Where should we store your app?"
      />
    )
  }

  // ---- Wizard footer ----

  function renderFooter(ctx: WizardContext) {
    ctxRef.current = ctx

    switch (ctx.activeStep) {
      case 'files':
        return (
          <>
            <Button variant="ghost" onClick={() => navigate(ROUTES.services)}>
              Cancel
            </Button>
            <div className="msw-footer-right">
              <Button
                onClick={() => confirmFiles(ctx)}
                disabled={
                  sourceType === 'upload'
                    ? files.length === 0
                    : !gitSourceConfirmed
                }
              >
                Next →
              </Button>
            </div>
          </>
        )
      case 'settings':
        return (
          <>
            <Button variant="ghost" onClick={() => ctx.goTo('files')}>
              ← Back
            </Button>
            <div className="msw-footer-right">
              <Button onClick={() => confirmEnvVars(ctx)}>Next →</Button>
            </div>
          </>
        )
      case 'details':
        return (
          <>
            <Button
              variant="ghost"
              onClick={() => ctx.goTo(hasEnvExample ? 'settings' : 'files')}
            >
              ← Back
            </Button>
            <div className="msw-footer-right">
              <Button
                onClick={() => confirmDeployConfig(ctx)}
                disabled={!appName || !envId || !resolvedNs || !canProceed}
              >
                {gitTargetsList.length === 1 ? 'Deploy →' : 'Next →'}
              </Button>
            </div>
          </>
        )
      case 'storage':
        return (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                ctx.goTo('details')
                setDeployConfigConfirmed(false)
                setStagedParams(null)
              }}
              disabled={deploying}
            >
              ← Back
            </Button>
            <div className="msw-footer-right">
              <Button
                onClick={() => {
                  const selection = gitOps.validate()
                  if (selection) void handleGitOpsConfirm(selection)
                }}
                disabled={
                  deploying ||
                  !gitOps.selectedTargetId ||
                  !gitOps.resolvedBranch
                }
                loading={deploying}
              >
                {deploying ? 'Deploying…' : 'Commit & Deploy'}
              </Button>
            </div>
          </>
        )
      default:
        return <span />
    }
  }

  // ---- Render ----

  return (
    <div
      className="ash-content vibe-deploy"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      {/* The MultiStepWizard (design-system, read-only) always renders a
          "Step X of Y: …" header and there is no prop to hide it. We pass no
          title, so drop the whole header here rather than patching the
          submodule (which would otherwise leave an empty padded gap). */}
      <style>{`.vibe-deploy .msw-header { display: none; }`}</style>
      <PageTitle
        title="Deploy"
        description="Drop the files your AI coding tool generated: we handle git, runtime detection, and deployment."
      />

      {noGitTargets && (
        <Alert
          tone="warning"
          title="No git targets configured."
          description={
            <>
              Portainer-Run requires a git repository to commit manifests and
              source files before deploying.{' '}
              <Link
                to={ROUTES.gitTargets}
                style={{ color: 'var(--accent, #2e90fa)' }}
              >
                Set one up in Git Targets
              </Link>{' '}
              first.
            </>
          }
        />
      )}

      <MultiStepWizard steps={wizardSteps} footer={renderFooter}>
        {(ctx) => {
          ctxRef.current = ctx
          switch (ctx.activeStep) {
            case 'files':
              return (
                <FilesStep
                  sourceType={sourceType}
                  setSourceType={setSourceType}
                  files={files}
                  onFilesAdded={handleFilesAdded}
                  onResetFiles={resetFiles}
                  onRemoveFile={removeFile}
                  gitTargetsList={gitTargetsList}
                  gitSourceTargetId={gitSourceTargetId}
                  setGitSourceTargetId={setGitSourceTargetId}
                  gitSourceBranch={gitSourceBranch}
                  setGitSourceBranch={setGitSourceBranch}
                  gitSourceBranches={gitSourceBranches}
                  setGitSourceBranches={setGitSourceBranches}
                  gitSourceConfirmed={gitSourceConfirmed}
                  setGitSourceConfirmed={setGitSourceConfirmed}
                  gitSourcePath={gitSourcePath}
                  detectedRuntime={detectedRuntime}
                  setDetectedRuntime={setDetectedRuntime}
                  loadGitSourceBranches={(id) => void loadGitSourceBranches(id)}
                  loadGitDir={loadGitDir}
                  onGitFolderSelect={(p) => void handleGitFolderSelect(p)}
                />
              )
            case 'settings':
              return <SettingsStep envVars={envVars} setEnvVars={setEnvVars} />
            case 'details':
              return (
                <DetailsStep
                  availableEnvs={environments.filter(
                    (e: Environment) => !isEnvDisabled({ disabledEnvs }, e.Id),
                  )}
                  appName={appName}
                  setAppName={setAppName}
                  envId={envId}
                  setEnvId={setEnvId}
                  nsList={nsList}
                  setNsList={setNsList}
                  nsLoading={nsLoading}
                  manualNs={manualNs}
                  setManualNs={setManualNs}
                  manualNsValue={manualNsValue}
                  setManualNsValue={setManualNsValue}
                  namespace={namespace}
                  setNamespace={setNamespace}
                  nsHint={nsHint}
                  setNsHint={setNsHint}
                  nsStatusColor={nsStatusColor}
                  resolvedNs={resolvedNs}
                  perms={perms}
                  envCapabilities={envCapabilities}
                  ingHost={ingHost}
                  setIngHost={setIngHost}
                  ingClass={ingClass}
                  setIngClass={setIngClass}
                  ingressHostMap={ingressHostMap}
                />
              )
            case 'storage':
              return renderStorageStep()
            case 'deploy':
              return (
                <StartupPanel
                  phase={startupPhase}
                  reason={startupReason}
                  url={startupUrl}
                  errorMsg={startupErrorMsg}
                  failStage={startupFailStage}
                  onFinish={finishToServices}
                  onReset={resetDeployForm}
                  onKeepWaiting={resumeWaiting}
                />
              )
            default:
              return null
          }
        }}
      </MultiStepWizard>
    </div>
  )
}
