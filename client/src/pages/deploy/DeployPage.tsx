import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Check, FileText, Loader2, Lock, Upload, X } from 'lucide-react'

import { Alert } from '@ds/v3-components/Alert/Alert'
import { Badge } from '@ds/v3-components/Badge/Badge'
import { Button } from '@ds/v3-components/Button/Button'
import type { FileNode } from '@ds/v3-components/FilePicker/FilePicker'
import { FormControl, Input } from '@ds/v3-components/FormField/FormField'
import { SegmentedControl } from '@ds/v3-components/Segmented/Segmented'
import { Select } from '@ds/v3-components/Select/Select'
import { Timeline, TimelineItem } from '@ds/v3-components/Timeline/Timeline'
import type { TimelineTone } from '@ds/v3-components/Timeline/Timeline'
import { MultiStepWizard } from '@ds/v3-templates/MultiStepWizard/MultiStepWizard'
import type { WizardContext, WizardStep } from '@ds/v3-templates/MultiStepWizard/MultiStepWizard'
import { PageTitle } from '@ds/v3-templates/PageTitle/PageTitle'

import { ROUTES } from '../../lib/routes.js'
import { listGitTargets, listRepoDir } from '../../lib/gitTargets.js'
import { dirEntriesToNodes } from './gitRepoTree'
import { GitFolderTree } from './GitFolderTree'
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
import {
  readDropEvent,
  readFileList,
  stripCommonRoot,
  type UploadedFile,
} from '../../lib/fileIntake'
import { MONO_FONT } from '../service-detail/detailUi'
import { GitOpsStepFields, useGitOpsSelection } from './GitOpsStep'
import type { GitOpsSelection } from './GitOpsStep'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

const STATIC_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.ts',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.webm', '.mp3', '.ogg',
  '.pdf', '.txt', '.md', '.xml', '.csv',
])

function isStaticFile(name: string) {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && STATIC_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

interface RuntimeDef {
  id: string
  label: string
  image: string
  detect?: (names: string[]) => boolean
  defaultCmd: (files: { name: string; text: string }[]) => string
  port: number
  workDir: string
}

const NGINX_RUNTIME: RuntimeDef = {
  id: 'nginx',
  label: 'nginx (static)',
  // Unprivileged NGINX: runs as UID 101, listens on 8080, and moves its PID and
  // temp paths to /tmp, so it needs no Linux capabilities at startup. Required
  // because all pods drop ALL capabilities under our pod security baseline (#39).
  // Note: a custom nginx.conf must include `pid /tmp/nginx.pid`.
  image: 'nginxinc/nginx-unprivileged:alpine',
  defaultCmd: () => "nginx -g 'daemon off;'",
  port: 8080,
  workDir: '/usr/share/nginx/html',
}

const RUNTIMES: RuntimeDef[] = [
  {
    id: 'node',
    label: 'Node.js 22',
    image: 'node:22',
    detect: (names) => {
      const base = names.map((n) => n.split('/').pop() as string)
      return base.includes('package.json') || base.includes('server.js')
    },
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
    label: 'Python 3.13',
    image: 'python:3.13-slim',
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
    label: 'PHP 8.4',
    image: 'php:8.4-apache',
    detect: (names) => names.some((n) => n.endsWith('.php')),
    defaultCmd: () => 'apache2-foreground',
    port: 80,
    workDir: '/var/www/html',
  },
  {
    id: 'ruby',
    label: 'Ruby 3.4',
    image: 'ruby:3.4-slim',
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

function detectRuntime(files: { name: string; text: string }[]): RuntimeDef {
  const names = files.map((f) => f.name)
  for (const rt of RUNTIMES) {
    if (rt.detect?.(names)) return rt
  }
  // Static site: all files are static assets (or single HTML)
  const nonEnv = files.filter((f) => f.name !== '.env.example' && !f.name.endsWith('.env.example'))
  if (nonEnv.length > 0 && nonEnv.every((f) => isStaticFile(f.name))) {
    return NGINX_RUNTIME
  }
  // Nothing matched — default to nginx as safe fallback
  return NGINX_RUNTIME
}

// ---------------------------------------------------------------------------
// .env.example parsing
// ---------------------------------------------------------------------------

interface EnvVar {
  key: string
  value: string
  custom?: boolean
}

function parseEnvExample(text: string): EnvVar[] {
  const vars: EnvVar[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key) vars.push({ key, value: val })
  }
  return vars
}

// Keys whose names imply a secret value. Kept in sync with the server's
// isSensitiveEnvKey in routes/vibe.js — matching values are stored in a
// Kubernetes Secret instead of being committed to git (issue #38).
const SECRET_PATTERN =
  /(^|[^A-Z])(PASSWORD|PASSWD|PASS|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH|DSN|CONNECTION[_-]?STRING|CERT|SIGNING)([^A-Z]|$)/i

// ---------------------------------------------------------------------------
// File drop zone
// ---------------------------------------------------------------------------

function DropZone({ onFiles }: { onFiles: (files: UploadedFile[]) => void }) {
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState(false)
  const folderRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const result = await readDropEvent(e)
    if (result) onFiles(result)
  }

  const active = dragging || hover
  const accent = 'var(--accent, #2e90fa)'

  return (
    <div
      role="button"
      tabIndex={0}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => folderRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          folderRef.current?.click()
        }
      }}
      style={{
        border: `1.5px dashed ${active ? accent : 'var(--border)'}`,
        borderRadius: 12,
        padding: '40px 24px',
        textAlign: 'center',
        cursor: 'pointer',
        outline: 'none',
        background: dragging
          ? `color-mix(in srgb, ${accent} 8%, transparent)`
          : hover
            ? 'color-mix(in srgb, var(--text) 3%, transparent)'
            : 'transparent',
        transition: 'border-color 120ms ease, background-color 120ms ease',
      }}
    >
      <input
        ref={folderRef}
        type="file"
        // @ts-expect-error non-standard folder-picker attribute
        webkitdirectory=""
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) void readFileList(e.target.files).then(onFiles)
        }}
      />
      <input
        ref={filesRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) void readFileList(e.target.files).then(onFiles)
        }}
      />
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: '50%',
          margin: '0 auto 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `color-mix(in srgb, ${accent} 12%, transparent)`,
          color: accent,
          transition: 'transform 120ms ease',
          transform: active ? 'translateY(-2px)' : 'none',
        }}
      >
        <Upload size={22} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
        {dragging ? 'Drop to upload' : 'Drop your project folder here'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>
        or browse below — we&rsquo;ll detect the runtime automatically
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <Button
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation()
            folderRef.current?.click()
          }}
        >
          Upload folder
        </Button>
        <Button
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation()
            filesRef.current?.click()
          }}
        >
          Upload files
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// File list row
// ---------------------------------------------------------------------------

function FileRow({
  file,
  tag,
  onRemove,
}: {
  file: UploadedFile
  tag: 'runtime' | 'env' | null
  onRemove: () => void
}) {
  const sizeKb = (file.size / 1024).toFixed(1)
  const isEnvFile = file.name === '.env.example' || file.name.endsWith('.env.example')
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '7px 10px',
      }}
    >
      <FileText
        size={12}
        style={{
          color: isEnvFile ? 'var(--status-warning, #f79009)' : 'var(--accent, #2e90fa)',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: MONO_FONT,
          fontSize: 11,
          color: 'var(--text)',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {file.webkitRelativePath && file.webkitRelativePath !== file.name
          ? file.webkitRelativePath
          : file.name}
      </span>
      <span
        style={{ fontFamily: MONO_FONT, fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}
      >
        {sizeKb} KB
      </span>
      {tag && (
        <Badge tone={tag === 'runtime' ? 'success' : 'warning'} size="sm">
          {tag === 'runtime' ? 'runtime' : '.env detected'}
        </Badge>
      )}
      <button
        type="button"
        onClick={onRemove}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--muted)',
          display: 'flex',
          padding: 2,
          flexShrink: 0,
        }}
        aria-label={`Remove ${file.name}`}
      >
        <X size={11} />
      </button>
    </div>
  )
}

/** Locked single-choice value shown instead of a select. */
function LockedValue({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '9px 12px',
        fontFamily: MONO_FONT,
        fontSize: 13,
        color: 'var(--text)',
      }}
    >
      <Lock size={11} style={{ color: 'var(--muted)' }} />
      {children}
    </div>
  )
}

function StepHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 16 }}>
      {children}
    </div>
  )
}

const HINT_STYLE: React.CSSProperties = { fontSize: 12, color: 'var(--muted)' }

// ---------------------------------------------------------------------------
// Startup progress (deploy → starting → ready)
// ---------------------------------------------------------------------------

const STARTUP_POLL_MS = 3000
// Vibe apps run npm/pip installs in init containers, so first boot can be slow.
const STARTUP_TIMEOUT_MS = 5 * 60 * 1000

type StartupPhase = 'deploying' | 'starting' | 'ready' | 'error' | 'timeout'

// Mirrors sanitizeStackName in server/routes/vibe.js: the deployment name and
// `app` label are derived from the entered app name, so we must match them when
// polling for readiness.
function sanitizeAppName(name: string) {
  return name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

// A subset of the human-friendly reasons from server/env-status.js that mean the
// app cannot recover on its own — surfacing these lets us stop waiting early.
function isBlockingReason(reason: string | null): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return (
    r.includes('keeps crashing') ||
    r.includes('download the image') ||
    r.includes('image name is invalid') ||
    r.includes('failed to start') ||
    r.includes('missing config') ||
    r.includes('memory limit') ||
    r.includes('exiting with errors')
  )
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
  const [ingressHostMap, setIngressHostMap] = useState<Record<string, string>>({})

  // Wizard navigation is owned by MultiStepWizard; keep the latest context so
  // async handlers (deploy success, file resets) can navigate too.
  const ctxRef = useRef<WizardContext | null>(null)

  const [noGitTargets, setNoGitTargets] = useState(false)
  const [gitTargetsList, setGitTargetsList] = useState<any[]>([])
  useEffect(() => {
    listGitTargets()
      .then((r: any) => {
        const list = r?.connections || []
        setNoGitTargets(list.length === 0)
        setGitTargetsList(list)
      })
      .catch(() => {})
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
  const [detectedRuntime, setDetectedRuntime] = useState<RuntimeDef | null>(null)
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
  const [exposeType, setExposeType] = useState('NodePort')
  const [svcPort] = useState('')
  const [ingHost, setIngHost] = useState('')
  const [ingPath] = useState('/')
  const [ingClass, setIngClass] = useState('')
  const [, setDeployConfigConfirmed] = useState(false)

  // ---- Env capabilities (for expose type filtering) ----
  // null = not yet probed, true = available, false = not available
  const [envCapabilities, setEnvCapabilities] = useState<{
    ingressOk: boolean | null
    lbOk: boolean | null
    probing: boolean
    ingressClasses: any[]
    defaultIngressClass: string | null
  }>({ ingressOk: null, lbOk: null, probing: false, ingressClasses: [], defaultIngressClass: null })

  // ---- Step 5: gitops (stagedParams) ----
  const [stagedParams, setStagedParams] = useState<any>(null)
  const [deploying, setDeploying] = useState(false)
  const gitOps = useGitOpsSelection()

  // ---- Startup progress (final step) ----
  const [startupPhase, setStartupPhase] = useState<StartupPhase | null>(null)
  const [startupReason, setStartupReason] = useState<string | null>(null)
  const [startupUrl, setStartupUrl] = useState<string | null>(null)
  const [startupErrorMsg, setStartupErrorMsg] = useState<string | null>(null)
  const [startupFailStage, setStartupFailStage] = useState<'deploy' | 'start' | null>(null)
  // Cancels the poll loop on unmount / navigation; sp used by "keep waiting".
  const startupCancelRef = useRef(false)
  const startupSpRef = useRef<any>(null)

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
      .then((p: any) => {
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
      const data: { files?: { path: string; type: 'file' | 'dir' }[] } = await listRepoDir(
        gitSourceTargetId,
        gitSourceBranch.trim(),
        path,
      )
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
          setAppName(parsed.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40))
          return
        }
      } catch { /* ignore */ }
    }
    // fallback to a slug from first meaningful file
    const mainFile = files.find((f) =>
      ['server.js', 'app.py', 'main.py', 'app.rb', 'index.php'].includes(f.name),
    )
    if (mainFile) {
      setAppName(mainFile.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase())
    }
  }, [files]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select environment when only one is available
  useEffect(() => {
    if (envId) return
    const available = environments.filter((e: any) => !isEnvDisabled({ disabledEnvs }, e.Id))
    if (available.length === 1) {
      setEnvId(String(available[0].Id))
    }
  }, [environments, disabledEnvs]) // eslint-disable-line react-hooks/exhaustive-deps

  // Probe env capabilities when envId changes (for expose type filtering)
  useEffect(() => {
    if (!envId || !token) {
      setEnvCapabilities({ ingressOk: null, lbOk: null, probing: false, ingressClasses: [], defaultIngressClass: null })
      return
    }
    setEnvCapabilities({ ingressOk: null, lbOk: null, probing: true, ingressClasses: [], defaultIngressClass: null })
    Promise.all([checkIngress(token, envId), checkLoadBalancer(token, envId)])
      .then(([ingressResult, lbResult]: any[]) => {
        const defaultClass =
          ingressResult.defaultClass ||
          (ingressResult.classes?.length === 1 ? ingressResult.classes[0].name : null)
        const caps = {
          ingressOk: ingressResult.ok !== false,
          lbOk: lbResult.ok !== false,
          probing: false,
          ingressClasses: ingressResult.classes || [],
          defaultIngressClass: defaultClass,
        }
        setEnvCapabilities(caps)
        // Auto-set expose type: prefer Ingress when it is available on the cluster
        setExposeType((prev) => {
          if (prev === 'LoadBalancer' && !caps.lbOk) return 'NodePort'
          if (prev === 'Ingress' && !caps.ingressOk) return 'NodePort'
          if (caps.ingressOk) return 'Ingress'
          return prev
        })
        // Auto-populate ingress class from cluster default
        if (defaultClass) setIngClass(defaultClass)
      })
      .catch(() => {
        // On error, show all options (permissive fallback)
        setEnvCapabilities({ ingressOk: true, lbOk: true, probing: false, ingressClasses: [], defaultIngressClass: null })
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
    kubeFetch(token, envId, `/apis/networking.k8s.io/v1/namespaces/${resolvedNs}/ingresses`)
      .then(async (r: Response) => {
        if (!r.ok) {
          setIngressHostMap({})
          return
        }
        const data = await r.json()
        const items = data.items || []
        const adminIngresses = items.filter(
          (item: any) => item.metadata?.labels?.['managed-by'] !== 'portainer-run',
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
      .then((r: any) => {
        if (r.ok) {
          if (r.manual) {
            setManualNs(true)
            setNsHint({ text: 'Enter your project space name below', tone: 'warn' })
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
          setNsHint({ text: r.error || 'Could not load project spaces', tone: 'err' })
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
      const data: { files?: { path: string; type: 'file' | 'dir' }[] } = await listRepoDir(
        gitSourceTargetId,
        gitSourceBranch.trim(),
        folderPath,
      )
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
      pushToast('No permission to create PersistentVolumeClaims in this project space', 'err')
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
    const cleanEnvVars = envVars
      .map((v) => ({ ...v, key: v.key.trim() }))
      .filter((v) => v.key)

    const portEnvVar = cleanEnvVars.find((v) => v.key === 'PORT')?.value
    const portValue = parseInt(String(svcPort || portEnvVar || detectedRuntime?.port || 80), 10)
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

    const params = {
      appName: appName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      ns: resolvedNs,
      envId,
      envName:
        environments.find((e: any) => String(e.Id) === String(envId))?.Name || String(envId),
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
            ? files.map((f) => ({ path: f.webkitRelativePath || f.name, content: f.text }))
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
    _params: any = null,
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
    } catch (e: any) {
      setStartupErrorMsg(e?.message || 'Unknown error')
      setStartupFailStage('deploy')
      setStartupPhase('error')
      pushToast('Deploy failed: ' + (e?.message || 'Unknown error'), 'err')
    } finally {
      setDeploying(false)
    }
  }

  // Poll Kubernetes (via Portainer) until the app's pods are ready, surfacing a
  // friendly status while it boots. Stops on ready, a blocking error, cancel, or
  // timeout.
  async function waitForAppReady(sp: any) {
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
    setExposeType('NodePort')
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
    ...(gitTargetsList.length !== 1 ? [{ id: 'storage', label: 'Storage' }] : []),
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

  function renderFilesStep() {
    return (
      <div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Source type toggle */}
          <div style={{ alignSelf: 'flex-start' }}>
            <SegmentedControl
              size="sm"
              options={[
                { value: 'upload', label: 'Upload files' },
                { value: 'git', label: 'From Git repository' },
              ]}
              value={sourceType}
              onChange={(val) => {
                setSourceType(val)
                setGitSourceConfirmed(false)
                setDetectedRuntime(null)
              }}
            />
          </div>

          {/* Upload source */}
          {sourceType === 'upload' && (
            <>
              {files.length === 0 ? (
                <DropZone onFiles={handleFilesAdded} />
              ) : (
                <>
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <span style={HINT_STYLE}>
                      {files.length} file{files.length !== 1 ? 's' : ''} selected
                    </span>
                    <Button variant="ghost" onClick={resetFiles}>
                      Remove all
                    </Button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {files.map((f, i) => (
                      <FileRow
                        key={f.webkitRelativePath || f.name}
                        file={f}
                        tag={
                          f.name === 'package.json' ||
                          f.name === 'requirements.txt' ||
                          f.name === 'Gemfile' ||
                          f.name === 'server.js'
                            ? 'runtime'
                            : f.name === '.env.example' || f.name.endsWith('.env.example')
                              ? 'env'
                              : null
                        }
                        onRemove={() => removeFile(i)}
                      />
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      id="vibe-add-folder"
                      type="file"
                      // @ts-expect-error non-standard folder-picker attribute
                      webkitdirectory=""
                      multiple
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        if (e.target.files?.length)
                          void readFileList(e.target.files).then(handleFilesAdded)
                      }}
                    />
                    <input
                      id="vibe-add-files"
                      type="file"
                      multiple
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        if (e.target.files?.length)
                          void readFileList(e.target.files).then(handleFilesAdded)
                      }}
                    />
                    <Button
                      variant="ghost"
                      onClick={() => document.getElementById('vibe-add-folder')?.click()}
                    >
                      + Add folder
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => document.getElementById('vibe-add-files')?.click()}
                    >
                      + Add files
                    </Button>
                  </div>
                </>
              )}
            </>
          )}

          {/* Git source */}
          {sourceType === 'git' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <FormControl label="Git target">
                <Select
                  value={gitSourceTargetId}
                  onChange={(e) => {
                    setGitSourceTargetId(e.target.value)
                    setGitSourceBranches([])
                    setGitSourceBranch('main')
                    setGitSourceConfirmed(false)
                    if (e.target.value) void loadGitSourceBranches(e.target.value)
                  }}
                  options={[
                    { value: '', label: '— Select —' },
                    ...gitTargetsList.map((t) => ({
                      value: t.id,
                      label: `${t.name}${t.shared ? ' (shared)' : ''}`,
                    })),
                  ]}
                />
              </FormControl>
              <FormControl label="Branch">
                {gitSourceBranches.length > 0 ? (
                  <Select
                    value={gitSourceBranch}
                    onChange={(e) => setGitSourceBranch(e.target.value)}
                    options={gitSourceBranches.map((b) => ({ value: b, label: b }))}
                  />
                ) : (
                  <Input
                    type="text"
                    value={gitSourceBranch}
                    onChange={(e) => setGitSourceBranch(e.target.value)}
                    placeholder="main"
                  />
                )}
              </FormControl>

              {!gitSourceTargetId || !gitSourceBranch.trim() ? (
                <div style={HINT_STYLE}>Choose a target and branch to browse the repository.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={HINT_STYLE}>
                    Expand folders to browse the repository and select the single folder that
                    contains your app. We&rsquo;ll deploy that folder and detect its runtime
                    automatically.
                  </div>
                  <GitFolderTree
                    key={`${gitSourceTargetId}:${gitSourceBranch}`}
                    loadChildren={loadGitDir}
                    selectedPath={gitSourceConfirmed ? gitSourcePath : null}
                    onSelect={handleGitFolderSelect}
                    maxHeight={320}
                  />
                </div>
              )}

              {gitSourceConfirmed && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 14px',
                    background: 'rgba(23,178,106,0.08)',
                    border: '1px solid rgba(23,178,106,0.3)',
                    borderRadius: 6,
                    fontSize: 12,
                    fontFamily: MONO_FONT,
                    color: 'var(--status-success, #17b26a)',
                  }}
                >
                  ✓ Deploying{' '}
                  <span style={{ color: 'var(--text)' }}>{gitSourcePath || 'repository root'}</span>
                  {detectedRuntime ? ` as ${detectedRuntime.label}` : ''}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  function renderSettingsStep() {
    return (
      <div>
        <StepHeading>App settings</StepHeading>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ ...HINT_STYLE, marginBottom: 4 }}>
            Your app needs a few settings — fill in the values below and they will be applied
            securely at deploy time.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {envVars.map((v, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 1fr auto',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                {v.custom ? (
                  <Input
                    type="text"
                    value={v.key}
                    placeholder="NAME"
                    style={{ fontFamily: MONO_FONT, fontSize: 12 }}
                    onChange={(e) =>
                      setEnvVars((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)),
                      )
                    }
                  />
                ) : (
                  <div
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 12,
                      color: 'var(--muted)',
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                      padding: '7px 10px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {v.key}
                  </div>
                )}
                <Input
                  type={SECRET_PATTERN.test(v.key) ? 'password' : 'text'}
                  value={v.value}
                  placeholder={SECRET_PATTERN.test(v.key) ? '••••••••' : 'value'}
                  onChange={(e) =>
                    setEnvVars((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  aria-label="Remove variable"
                  onClick={() => setEnvVars((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setEnvVars((prev) => [...prev, { key: '', value: '', custom: true }])}
          >
            + Add variable
          </Button>
          <div style={HINT_STYLE}>
            Values whose name looks sensitive (password, token, key, secret, and similar) are
            hidden here, stored in a Kubernetes Secret in your project space, and are never
            written into the git repository. Other values are committed as plain configuration.
          </div>
        </div>
      </div>
    )
  }

  function renderDetailsStep() {
    const availableEnvs = environments.filter((e: any) => !isEnvDisabled({ disabledEnvs }, e.Id))
    const singleEnv = availableEnvs.length === 1
    const singleNs = nsList.length === 1 && !nsLoading && !manualNs
    const activeBaseDomain = ingressHostMap[ingClass] || ''

    return (
      <div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ maxWidth: 420 }}>
            <FormControl label="App name" hint="Lowercase, alphanumeric and hyphens">
              <Input
                type="text"
                value={appName}
                onChange={(e) =>
                  setAppName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                }
                placeholder="my-app"
              />
            </FormControl>
          </div>

          {/* When the user has exactly one environment and one project space,
              there is nothing to choose. Hide the infrastructure selectors
              entirely — non-technical users should not have to reason about
              environments or namespaces (per user feedback). The values are
              auto-selected elsewhere, so deploy still has everything it needs. */}
          {singleEnv && singleNs ? (
            <div style={{ ...HINT_STYLE, marginBottom: 4 }}>
              Deploying to <strong style={{ color: 'var(--text)' }}>{availableEnvs[0].Name}</strong>
              {' / '}
              <strong style={{ color: 'var(--text)' }}>{nsList[0]}</strong>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <FormControl label="Deployment target" hint="Portainer environment to deploy into">
                  {availableEnvs.length === 1 ? (
                    <LockedValue>{availableEnvs[0].Name}</LockedValue>
                  ) : (
                    <Select
                      value={envId}
                      onChange={(e) => {
                        setEnvId(e.target.value)
                        setNamespace('')
                        setNsList([])
                        setManualNs(false)
                        setNsHint({ text: '', tone: 'dim' })
                      }}
                      options={[
                        { value: '', label: '— Select —' },
                        ...availableEnvs.map((e: any) => ({
                          value: String(e.Id),
                          label: e.Name,
                        })),
                      ]}
                    />
                  )}
                </FormControl>
              </div>
              <div style={{ flex: 1 }}>
                <FormControl
                  label="Project space"
                  hint="Project space must already exist in the target"
                >
                  <div>
                    {!manualNs ? (
                      nsList.length === 1 && !nsLoading ? (
                        <LockedValue>{nsList[0]}</LockedValue>
                      ) : (
                        <Select
                          value={namespace}
                          onChange={(e) => setNamespace(e.target.value)}
                          disabled={!envId || nsLoading}
                          options={[
                            {
                              value: '',
                              label: !envId
                                ? 'Select target first...'
                                : nsLoading
                                  ? 'Loading project spaces...'
                                  : '— Select —',
                            },
                            ...nsList.map((n) => ({ value: n, label: n })),
                          ]}
                        />
                      )
                    ) : (
                      <Input
                        type="text"
                        value={manualNsValue}
                        onChange={(e) => setManualNsValue(e.target.value)}
                        placeholder="my-project-space"
                      />
                    )}
                    {nsHint.text && (
                      <div
                        style={{
                          fontFamily: MONO_FONT,
                          fontSize: 12,
                          color: nsStatusColor,
                          marginTop: 4,
                        }}
                      >
                        {nsHint.text}
                      </div>
                    )}
                  </div>
                </FormControl>
              </div>
            </div>
          )}

          {perms && (!perms.canDeploy || !perms.canCreatePvc) && (
            <Alert
              tone="danger"
              title={
                <>
                  {!perms.canDeploy && (
                    <div>
                      No permission to create Deployments in project space &quot;{resolvedNs}
                      &quot;.
                    </div>
                  )}
                  {!perms.canCreatePvc && (
                    <div>
                      No permission to create PersistentVolumeClaims in project space &quot;
                      {resolvedNs}&quot;.
                    </div>
                  )}
                </>
              }
              description="Select a different project space or contact your platform administrator."
            />
          )}

          <div style={{ maxWidth: 420 }}>
            <FormControl label="Expose as">
              <div>
                <Select
                  value={exposeType}
                  onChange={(e) => setExposeType(e.target.value)}
                  disabled={envCapabilities.probing}
                  options={[
                    {
                      value: 'NodePort',
                      label: 'Network Accessible - Default, use this unless advised otherwise',
                    },
                    ...(envCapabilities.probing || envCapabilities.lbOk !== false
                      ? [{ value: 'LoadBalancer', label: 'Network Accessible via dedicated IP' }]
                      : []),
                    ...(envCapabilities.probing || envCapabilities.ingressOk !== false
                      ? [{ value: 'Ingress', label: 'Network Accessible via a URL' }]
                      : []),
                  ]}
                />
                {!envCapabilities.probing &&
                  envId &&
                  (envCapabilities.lbOk === false || envCapabilities.ingressOk === false) && (
                    <div style={{ ...HINT_STYLE, marginTop: 4 }}>
                      {[
                        envCapabilities.lbOk === false && 'LoadBalancer',
                        envCapabilities.ingressOk === false && 'Ingress',
                      ]
                        .filter(Boolean)
                        .join(' and ')}{' '}
                      not detected on this cluster — option
                      {envCapabilities.lbOk === false && envCapabilities.ingressOk === false
                        ? 's'
                        : ''}{' '}
                      hidden
                    </div>
                  )}
              </div>
            </FormControl>
          </div>

          {exposeType === 'Ingress' && (
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <FormControl label="Hostname">
                  {activeBaseDomain ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                      <Input
                        type="text"
                        value={appName}
                        onChange={(e) =>
                          setAppName(e.target.value.replace(/[^a-z0-9-]/gi, '-').toLowerCase())
                        }
                        style={{
                          borderRadius: '6px 0 0 6px',
                          borderRight: 'none',
                          flex: '0 0 auto',
                          width: 140,
                        }}
                      />
                      <span
                        style={{
                          padding: '8px 12px',
                          background: 'var(--bg)',
                          border: '1px solid var(--border)',
                          borderRadius: '0 6px 6px 0',
                          fontFamily: MONO_FONT,
                          fontSize: 13,
                          color: 'var(--muted)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        .{activeBaseDomain}
                      </span>
                    </div>
                  ) : (
                    <Input
                      type="text"
                      value={ingHost}
                      onChange={(e) => setIngHost(e.target.value)}
                      placeholder="app.example.com"
                    />
                  )}
                </FormControl>
              </div>
              <div style={{ flex: 1 }}>
                <FormControl label="Ingress class">
                  {envCapabilities.ingressClasses.length > 1 ? (
                    <Select
                      value={ingClass}
                      onChange={(e) => setIngClass(e.target.value)}
                      options={envCapabilities.ingressClasses.map((c: any) => ({
                        value: c.name,
                        label: `${c.name}${c.isDefault ? ' (default)' : ''}`,
                      }))}
                    />
                  ) : (
                    <Input
                      type="text"
                      value={ingClass}
                      onChange={(e) => setIngClass(e.target.value)}
                      placeholder="nginx"
                      readOnly={envCapabilities.ingressClasses.length === 1}
                      style={
                        envCapabilities.ingressClasses.length === 1
                          ? { opacity: 0.6, cursor: 'default' }
                          : {}
                      }
                    />
                  )}
                </FormControl>
              </div>
            </div>
          )}

          {(!appName || !envId || !resolvedNs) && (
            <div
              style={{
                textAlign: 'right',
                fontSize: 12,
                color: 'var(--status-warning, #f79009)',
              }}
            >
              {[
                !appName && 'Enter an app name',
                !envId && 'Select a deployment target',
                !resolvedNs && 'Select a project space',
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>
      </div>
    )
  }

  function renderStartupPanel() {
    const phase = startupPhase
    const spinner = <Loader2 size={12} className="animate-spin" />
    const check = <Check size={12} strokeWidth={2.5} />
    const cross = <X size={12} strokeWidth={2.5} />

    const deployFailed = phase === 'error' && startupFailStage === 'deploy'
    const startFailed = phase === 'error' && startupFailStage === 'start'

    // Step 1 — Deploying
    let s1: { tone: TimelineTone; bullet?: React.ReactNode; desc: React.ReactNode }
    if (phase === 'deploying') {
      s1 = { tone: 'accent', bullet: spinner, desc: 'Saving your app and setting things up' }
    } else if (deployFailed) {
      s1 = { tone: 'danger', bullet: cross, desc: startupErrorMsg || 'Something went wrong while setting up' }
    } else {
      s1 = { tone: 'success', bullet: check, desc: 'Saved and set up' }
    }

    // Step 2 — Starting
    let s2: { tone: TimelineTone; bullet?: React.ReactNode; desc: React.ReactNode }
    if (phase === 'deploying' || deployFailed) {
      s2 = { tone: 'neutral', desc: 'Waiting for your app to start' }
    } else if (phase === 'starting') {
      s2 = { tone: 'accent', bullet: spinner, desc: startupReason || 'Waiting for your app to start' }
    } else if (phase === 'timeout') {
      s2 = { tone: 'warning', bullet: spinner, desc: startupReason || 'This is taking longer than usual — still starting' }
    } else if (startFailed) {
      s2 = { tone: 'danger', bullet: cross, desc: startupReason || "Your app couldn't start" }
    } else {
      s2 = { tone: 'success', bullet: check, desc: 'Started successfully' }
    }

    // Step 3 — Ready
    const s3: { tone: TimelineTone; bullet?: React.ReactNode; desc: React.ReactNode } =
      phase === 'ready'
        ? { tone: 'success', bullet: check, desc: 'Your app is up and running' }
        : { tone: 'neutral', desc: 'Your app will be live here' }

    return (
      <div>
        <StepHeading>{phase === 'ready' ? 'Your app is live' : 'Deploying your app'}</StepHeading>
        <div style={{ maxWidth: 460, padding: '8px 4px 4px' }}>
          <Timeline>
            <TimelineItem tone={s1.tone} bullet={s1.bullet} title="Deploying" description={s1.desc} />
            <TimelineItem tone={s2.tone} bullet={s2.bullet} title="Starting" description={s2.desc} />
            <TimelineItem tone={s3.tone} bullet={s3.bullet} title="Ready" description={s3.desc} />
          </Timeline>
        </div>
        {renderStartupActions()}
      </div>
    )
  }

  function renderStartupActions() {
    if (startupPhase === 'ready') {
      return (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
          {startupUrl && (
            <Button onClick={() => window.open(startupUrl, '_blank', 'noopener,noreferrer')}>
              Open my app
            </Button>
          )}
          <Button variant={startupUrl ? 'ghost' : undefined} onClick={finishToServices}>
            Go to my apps
          </Button>
        </div>
      )
    }
    if (startupPhase === 'error') {
      return (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
          <Button onClick={finishToServices}>View application</Button>
          <Button variant="ghost" onClick={resetDeployForm}>
            Start over
          </Button>
        </div>
      )
    }
    if (startupPhase === 'timeout') {
      return (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
          <Button onClick={resumeWaiting}>Keep waiting</Button>
          <Button variant="ghost" onClick={finishToServices}>
            View application
          </Button>
        </div>
      )
    }
    return null
  }

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
                disabled={sourceType === 'upload' ? files.length === 0 : !gitSourceConfirmed}
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
            <Button variant="ghost" onClick={() => ctx.goTo(hasEnvExample ? 'settings' : 'files')}>
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
                disabled={deploying || !gitOps.selectedTargetId || !gitOps.resolvedBranch}
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
              Portainer-Run requires a git repository to commit manifests and source files before
              deploying.{' '}
              <Link to={ROUTES.gitTargets} style={{ color: 'var(--accent, #2e90fa)' }}>
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
              return renderFilesStep()
            case 'settings':
              return renderSettingsStep()
            case 'details':
              return renderDetailsStep()
            case 'storage':
              return renderStorageStep()
            case 'deploy':
              return renderStartupPanel()
            default:
              return null
          }
        }}
      </MultiStepWizard>
    </div>
  )
}
