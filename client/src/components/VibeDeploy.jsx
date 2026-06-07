import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ROUTES } from '../lib/routes.js'
import { listGitTargets } from '../lib/gitTargets.js'
import { useAppStore, visibleEnvironments, isEnvDisabled } from '../store/useAppStore.js'
import { fetchNamespaceOptions } from '../lib/deployK8s.js'
import { checkEnvPermissions } from '../lib/envPermissions.js'
import { GitOpsStep } from './deploy/GitOpsStep.jsx'

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

function isStaticFile(name) {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && STATIC_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

const NGINX_RUNTIME = {
  id: 'nginx',
  label: 'nginx (static)',
  image: 'nginx:alpine',
  defaultCmd: () => "nginx -g 'daemon off;'",
  port: 80,
  workDir: '/usr/share/nginx/html',
}

const RUNTIMES = [
  {
    id: 'node',
    label: 'Node.js 20',
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
    label: 'Python 3.12',
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
    label: 'PHP 8.3',
    image: 'php:8.3-apache',
    detect: (names) => names.some((n) => n.endsWith('.php')),
    defaultCmd: () => 'apache2-foreground',
    port: 80,
    workDir: '/var/www/html',
  },
  {
    id: 'ruby',
    label: 'Ruby 3.3',
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

function detectRuntime(files) {
  const names = files.map((f) => f.name)
  for (const rt of RUNTIMES) {
    if (rt.detect(names)) return rt
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

function parseEnvExample(text) {
  const vars = []
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

const SECRET_PATTERN = /SECRET|KEY|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL/i

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------
// File drop zone
// ---------------------------------------------------------------------------

function readFileEntry(entry) {
  return new Promise((resolve) => {
    entry.file((file) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve({
        name: file.name, size: file.size, text: e.target.result,
        webkitRelativePath: entry.fullPath.replace(/^\//, ''),
      })
      reader.onerror = () => resolve({ name: file.name, size: file.size, text: '', webkitRelativePath: entry.fullPath.replace(/^\//, '') })
      reader.readAsText(file)
    })
  })
}

function readDirEntry(dirEntry) {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader()
    const allEntries = []
    function readBatch() {
      reader.readEntries((entries) => {
        if (!entries.length) { resolve(allEntries); return }
        allEntries.push(...entries)
        readBatch()
      })
    }
    readBatch()
  })
}

async function traverseEntry(entry) {
  if (entry.isFile) return [await readFileEntry(entry)]
  if (entry.isDirectory) {
    const children = await readDirEntry(entry)
    const nested = await Promise.all(children.map(traverseEntry))
    return nested.flat()
  }
  return []
}

function DropZone({ onFiles }) {
  const [dragging, setDragging] = useState(false)
  const folderRef = useRef(null)
  const filesRef = useRef(null)

  function readFileList(fileList) {
    const readers = Array.from(fileList).map((file) => new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve({ name: file.name, size: file.size, text: e.target.result, webkitRelativePath: file.webkitRelativePath || file.name })
      reader.onerror = () => resolve({ name: file.name, size: file.size, text: '', webkitRelativePath: file.webkitRelativePath || file.name })
      reader.readAsText(file)
    }))
    Promise.all(readers).then(onFiles)
  }

  async function onDrop(e) {
    e.preventDefault()
    setDragging(false)
    // Use DataTransferItem API for folder support
    const items = e.dataTransfer.items
    if (items && items.length) {
      const entries = Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter(Boolean)
      if (entries.length) {
        const all = (await Promise.all(entries.map(traverseEntry))).flat()
        onFiles(all)
        return
      }
    }
    if (e.dataTransfer.files.length) readFileList(e.dataTransfer.files)
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{
        border: `1.5px dashed ${dragging ? 'var(--accent)' : 'var(--border2)'}`,
        borderRadius: 8, padding: '32px 20px', textAlign: 'center',
        background: dragging ? 'var(--accent-hover)' : 'transparent',
        transition: 'border-color .15s, background .15s',
      }}
    >
      <input ref={folderRef} type="file" webkitdirectory="" multiple style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files.length) readFileList(e.target.files) }} />
      <input ref={filesRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files.length) readFileList(e.target.files) }} />
      <div style={{
        width: 40, height: 40, background: 'var(--surface2)', border: '1px solid var(--border2)',
        borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px',
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.8">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 10 }}>
        Drop a folder here, or select below
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => folderRef.current?.click()}>
          Select folder
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => filesRef.current?.click()}>
          Select files
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// File list row
// ---------------------------------------------------------------------------

function FileRow({ file, tag, onRemove }) {
  const sizeKb = (file.size / 1024).toFixed(1)
  const isEnvFile = file.name === '.env.example' || file.name.endsWith('.env.example')
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      background: 'var(--bg)', border: `1px solid ${isEnvFile ? 'rgba(251,191,36,.25)' : 'var(--border)'}`,
      borderRadius: 6, padding: '7px 10px',
    }}>
      <div style={{
        width: 22, height: 22, background: 'var(--surface2)', borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
          stroke={isEnvFile ? 'var(--status-warning)' : 'var(--accent)'} strokeWidth="1.8">
          <path d="M14 2H6a2 2 0 0 0-2 2v16h12V8z" /><polyline points="14 2 14 8 20 8" />
        </svg>
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {file.webkitRelativePath && file.webkitRelativePath !== file.name ? file.webkitRelativePath : file.name}
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--subtle)', flexShrink: 0 }}>{sizeKb} KB</span>
      {tag && (
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9, padding: '1px 6px', borderRadius: 3, flexShrink: 0,
          background: tag === 'runtime' ? 'rgba(74,222,128,.1)' : 'rgba(251,191,36,.1)',
          color: tag === 'runtime' ? 'var(--status-success)' : 'var(--status-warning)',
          border: `1px solid ${tag === 'runtime' ? 'rgba(74,222,128,.2)' : 'rgba(251,191,36,.2)'}`,
        }}>
          {tag === 'runtime' ? 'runtime' : '.env detected'}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--subtle)', display: 'flex', padding: 2, flexShrink: 0 }}
        aria-label={`Remove ${file.name}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
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

  // ---- Step tracking ----
  // 1=files, 2=runtime, 3=envvars, 4=deployconfig, 5=gitops
  const [noGitTargets, setNoGitTargets] = useState(false)
  useEffect(() => {
    listGitTargets().then((r) => setNoGitTargets(!r || r.length === 0)).catch(() => {})
  }, [])

  const [step, setStep] = useState(1)

  // ---- Step 1: files ----
  const [files, setFiles] = useState([])

  // ---- Step 2: runtime ----
  const [detectedRuntime, setDetectedRuntime] = useState(null)
  const [startCmd, setStartCmd] = useState('')
  const [overrideCmd, setOverrideCmd] = useState(false)
  const [runtimeConfirmed, setRuntimeConfirmed] = useState(false)

  // ---- Step 3: env vars ----
  const [envVars, setEnvVars] = useState([]) // [{ key, value }]
  const [envVarsConfirmed, setEnvVarsConfirmed] = useState(false)
  const hasEnvExample = files.some((f) => f.name === '.env.example' || f.name.endsWith('.env.example'))

  // ---- Step 4: deploy config ----
  const [appName, setAppName] = useState('')
  const [envId, setEnvId] = useState('')
  const [nsList, setNsList] = useState([])
  const [nsLoading, setNsLoading] = useState(false)
  const [namespace, setNamespace] = useState('')
  const [manualNs, setManualNs] = useState(false)
  const [manualNsValue, setManualNsValue] = useState('')
  const [nsHint, setNsHint] = useState({ text: '', tone: 'dim' })
  const [instances, setInstances] = useState(1)
  const [exposeType, setExposeType] = useState('none')
  const [svcPort, setSvcPort] = useState('')
  const [ingHost, setIngHost] = useState('')
  const [ingPath, setIngPath] = useState('/')
  const [ingClass, setIngClass] = useState('')
  const [deployConfigConfirmed, setDeployConfigConfirmed] = useState(false)

  // ---- Step 5: gitops (stagedParams) ----
  const [stagedParams, setStagedParams] = useState(null)
  const [deploying, setDeploying] = useState(false)

  const resolvedNs = manualNs ? manualNsValue.trim() : namespace
  const permKey = envId && resolvedNs ? `${envId}:${resolvedNs}` : null
  const perms = permKey ? (envPermissions[permKey] || null) : null
  // Vibe Deploy always creates a PVC — check both
  const canProceed = !perms || (perms.canDeploy && perms.canCreatePvc)

  // ---- Derived tags for file list ----
  const runtimeFile = detectedRuntime
    ? files.find((f) => f.name === 'package.json' || f.name === 'requirements.txt' || f.name === 'Gemfile')
    : null

  // ---- Effects ----

  // Permission check when env + ns are both set
  useEffect(() => {
    if (!envId || !resolvedNs || !token) return
    const key = `${envId}:${resolvedNs}`
    if (envPermissions[key] !== undefined) return
    checkEnvPermissions(token, envId, resolvedNs).then((p) => {
      patchEnvPermissions(envId, resolvedNs, p)
    }).catch(() => { /* silent — default is permissive */ })
  }, [envId, resolvedNs, token, envPermissions, patchEnvPermissions])

  // Auto-detect runtime when files change
  useEffect(() => {
    if (!files.length) { setDetectedRuntime(null); setStartCmd(''); setRuntimeConfirmed(false); return }
    const rt = detectRuntime(files)
    setDetectedRuntime(rt)
    if (rt) setStartCmd(rt.defaultCmd(files))
    setRuntimeConfirmed(false)
  }, [files])

  // Auto-detect env vars when files change
  useEffect(() => {
    const envFile = files.find((f) => f.name === '.env.example' || f.name.endsWith('.env.example'))
    if (envFile) {
      setEnvVars(parseEnvExample(envFile.text))
    } else {
      setEnvVars([])
    }
    setEnvVarsConfirmed(false)
  }, [files])

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
    const mainFile = files.find((f) => ['server.js','app.py','main.py','app.rb','index.php'].includes(f.name))
    if (mainFile) {
      setAppName(mainFile.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase())
    }
  }, [files]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch namespaces when envId changes
  useEffect(() => {
    if (!envId || !token) {
      setNsList([]); setNamespace(''); setManualNs(false)
      setNsHint({ text: '', tone: 'dim' })
      return
    }
    setNsLoading(true)
    setNsList([]); setNamespace('')
    fetchNamespaceOptions(token, envId).then((r) => {
      if (r.ok) {
        if (r.manual) {
          setManualNs(true)
          setNsHint({ text: r.message || 'Enter namespace manually', tone: 'warn' })
        } else {
          setNsList(r.namespaces)
          setManualNs(false)
          setNamespace('')
          setNsHint({ text: `${r.namespaces.length} namespace${r.namespaces.length !== 1 ? 's' : ''} found`, tone: 'ok' })
        }
      } else {
        setManualNs(true)
        setNsHint({ text: r.error || 'Could not load namespaces', tone: 'err' })
      }
    }).catch(() => {
      setManualNs(true)
      setNsHint({ text: 'Could not load namespaces', tone: 'err' })
    }).finally(() => setNsLoading(false))
  }, [envId, token])

  // ---- Handlers ----

  function stripCommonRoot(files) {
    // If all files share the same root folder (e.g. expense-tracker/server.js),
    // strip that root so paths are relative to the app root, not the folder name.
    if (!files.length) return files
    const paths = files.map((f) => f.webkitRelativePath || f.name)
    const firstSeg = paths[0].split('/')[0]
    const allSameRoot = paths.every((p) => p.startsWith(firstSeg + '/'))
    if (!allSameRoot) return files
    return files.map((f) => ({
      ...f,
      webkitRelativePath: (f.webkitRelativePath || f.name).slice(firstSeg.length + 1),
    }))
  }

  function handleFilesAdded(newFiles) {
    const stripped = stripCommonRoot(newFiles)
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.webkitRelativePath || f.name))
      const merged = [...prev]
      for (const f of stripped) {
        const key = f.webkitRelativePath || f.name
        if (!existing.has(key)) { merged.push(f); existing.add(key) }
      }
      return merged
    })
    setRuntimeConfirmed(false)
    setEnvVarsConfirmed(false)
    setDeployConfigConfirmed(false)
    setStagedParams(null)
    setStep(1)
  }

  function removeFile(idx) {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
    setRuntimeConfirmed(false); setEnvVarsConfirmed(false)
    setDeployConfigConfirmed(false); setStagedParams(null)
    setStep(1)
  }

  function confirmFiles() {
    if (!files.length) { pushToast('Add at least one file', 'err'); return }
    setStep(2)
  }

  function confirmRuntime() {
    if (!detectedRuntime) { pushToast('Runtime could not be detected — check your files', 'err'); return }
    if (!startCmd.trim()) { pushToast('Enter a start command', 'err'); return }
    setRuntimeConfirmed(true)
    setStep(hasEnvExample ? 3 : 4)
  }

  function confirmEnvVars() {
    setEnvVarsConfirmed(true)
    setStep(4)
  }

  function confirmDeployConfig() {
    if (!appName.trim()) { pushToast('App name is required', 'err'); return }
    if (perms && !perms.canDeploy) { pushToast('No deploy permission in this namespace', 'err'); return }
    if (perms && !perms.canCreatePvc) { pushToast('No permission to create PersistentVolumeClaims in this namespace', 'err'); return }
    if (!envId) { pushToast('Select a target environment', 'err'); return }
    if (!resolvedNs) { pushToast('Select or enter a namespace', 'err'); return }

    // Build deploy params for GitOpsStep dry-run + actual deploy
    // Priority: user-entered svcPort > PORT env var > runtime default
    const portEnvVar = envVars.find((v) => v.key === 'PORT')?.value
    const portValue = parseInt(String(svcPort || portEnvVar || detectedRuntime?.port || 80), 10)
    const resolvedPort = isNaN(portValue) ? 80 : portValue

    // Build a single-container spec representing the vibe deploy
    const containerSpec = {
      name: appName,
      image: detectedRuntime?.image || 'node:20-alpine',
      command: startCmd ? startCmd.split(/\s+/) : undefined,
      workingDir: detectedRuntime?.workDir || '/app',
      ports: [{ containerPort: resolvedPort, protocol: 'TCP' }],
      env: envVars.filter((v) => v.key).map((v) => ({ name: v.key, value: v.value })),
    }

    const params = {
      appName: appName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      ns: resolvedNs,
      envId,
      envName: environments.find((e) => String(e.Id) === String(envId))?.Name || String(envId),
      instances,
      containerSpecs: [containerSpec],
      containerRowIds: ['vibe-0'],
      volumeDefs: [{
        name: `${appName}-data`,
        size: '1Gi',
        mountPath: detectedRuntime?.workDir || '/app',
        containerId: 'vibe-0',
        storageClass: '',
        // Vibe deploy marker — server uses this to generate init container
        vibeSource: true,
      }],
      exposeType: exposeType === 'none' ? 'none' : exposeType,
      servicePorts: [resolvedPort],
      ingress: {
        host: ingHost,
        path: ingPath || '/',
        port: resolvedPort,
        ingressClass: ingClass,
      },
      // Vibe-specific extras passed through to server
      vibeParams: {
        runtime: detectedRuntime?.id || 'node',
        runtimeImage: detectedRuntime?.image || 'node:20-alpine',
        startCmd: startCmd.trim(),
        workDir: detectedRuntime?.workDir || '/app',
        envVars: envVars.filter((v) => v.key),
        sourceFiles: files.map((f) => ({ path: f.webkitRelativePath || f.name, content: f.text })),
      },
    }

    setStagedParams(params)
    setDeployConfigConfirmed(true)
    setStep(5)
  }

  async function handleGitOpsConfirm({ gitTargetId, branch, pathPrefix, pollInterval }) {
    if (!stagedParams) return
    setDeploying(true)
    try {
      const { portainerBaseUrl, portainerFromServer, token: tok } = useAppStore.getState()
      const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': tok,
      }
      const u = (portainerBaseUrl || '').trim()
      if (u && !portainerFromServer) headers['X-Portainer-URL'] = u

      const res = await fetch('/api/vibe/deploy', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          gitTargetId,
          branch,
          pathPrefix,
          pollInterval,
          envId: stagedParams.envId,
          envName: stagedParams.envName,
          vibeParams: stagedParams.vibeParams,
          deployParams: {
            appName: stagedParams.appName,
            ns: stagedParams.ns,
            instances: stagedParams.instances,
            containerSpecs: stagedParams.containerSpecs,
            containerRowIds: stagedParams.containerRowIds,
            volumeDefs: stagedParams.volumeDefs,
            exposeType: stagedParams.exposeType,
            servicePorts: stagedParams.servicePorts,
            ingress: stagedParams.ingress,
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      pushToast(`${stagedParams.appName} deployed successfully`, 'ok')
      navigate(ROUTES.services)
      // Reset form
      setFiles([]); setStep(1); setStagedParams(null)
      setRuntimeConfirmed(false); setEnvVarsConfirmed(false); setDeployConfigConfirmed(false)
      setAppName(''); setEnvId(''); setNamespace(''); setInstances(1)
      setExposeType('none'); setIngHost(''); setIngPath('/'); setIngClass('')
    } catch (e) {
      pushToast('Deploy failed: ' + (e?.message || 'Unknown error'), 'err')
    } finally {
      setDeploying(false)
    }
  }


  // ---- Render helpers ----

  const VD_STEPS = [
    { num: 1, label: 'Files' },
    { num: 2, label: 'Runtime' },
    { num: 3, label: 'Env Vars' },
    { num: 4, label: 'Deploy' },
    { num: 5, label: 'GitOps' },
  ]

  const visibleSteps = hasEnvExample ? VD_STEPS : VD_STEPS.filter((s) => s.num !== 3).map((s, i) => ({ ...s, num: i + 1 }))
  // Map logical step to display step
  const displayStep = hasEnvExample ? step : step < 3 ? step : step === 4 ? 3 : step === 5 ? 4 : step

  const nsStatusColor = nsHint.tone === 'warn' ? 'var(--amber)'
    : nsHint.tone === 'ok' ? 'var(--green)'
    : nsHint.tone === 'err' ? 'var(--red)' : 'var(--text-dim)'

  // ---- Render ----

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Vibe Deploy</div>
          <div className="page-sub">
            Drop your Claude-generated files — we handle git, runtime detection, and deployment.
          </div>
        </div>
      </div>

      <div className="deploy-form">
      {noGitTargets && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 16px', marginBottom: 16,
          background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)',
          borderRadius: 8, fontSize: 13,
        }}>
          <span style={{ color: 'var(--amber)', fontSize: 16, flexShrink: 0 }}>⚠</span>
          <span style={{ color: 'var(--text)' }}>
            No git targets configured. Portainer Run requires a git repository to commit manifests and source files before deploying.{' '}
            <Link to={ROUTES.gitTargets} style={{ color: 'var(--accent)' }}>Set one up in Git Targets</Link> first.
          </span>
        </div>
      )}
        {/* Stepper */}
        <div className="mb-stepper">
          {visibleSteps.map((s, i) => {
            const state = s.num < displayStep ? 'done' : s.num === displayStep ? 'active' : 'idle'
            return (
              <div key={s.num} style={{ display: 'flex', alignItems: 'center' }}>
                <div className={`mb-step mb-step--${state}`}>
                  <div className="mb-step-num">{state === 'done' ? '✓' : s.num}</div>
                  <span className="mb-step-label">{s.label}</span>
                </div>
                {i < visibleSteps.length - 1 && <div className="mb-step-sep" />}
              </div>
            )
          })}
        </div>

        {/* ── Step 1: Files ── */}
        {step === 1 && (
          <div className="form-section">
            <div className="form-section-head">Step 1 — Files</div>
            <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {files.length === 0 ? (
                <DropZone onFiles={handleFilesAdded} />
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="hint">{files.length} file{files.length !== 1 ? 's' : ''} selected</span>
                    <button type="button" className="btn btn-ghost btn-xs"
                      onClick={() => { setFiles([]); setRuntimeConfirmed(false); setEnvVarsConfirmed(false); setDeployConfigConfirmed(false); setStagedParams(null) }}>
                      Remove all
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {files.map((f, i) => (
                      <FileRow
                        key={f.webkitRelativePath || f.name}
                        file={f}
                        tag={
                          (f.name === 'package.json' || f.name === 'requirements.txt' || f.name === 'Gemfile') ? 'runtime'
                          : (f.name === '.env.example' || f.name.endsWith('.env.example')) ? 'env'
                          : null
                        }
                        onRemove={() => removeFile(i)}
                      />
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input id="vibe-add-folder" type="file" webkitdirectory="" multiple style={{ display: 'none' }}
                      onChange={(e) => { if (e.target.files.length) {
                        const readers = Array.from(e.target.files).map((file) => new Promise((res) => {
                          const r = new FileReader()
                          r.onload = (ev) => res({ name: file.name, size: file.size, text: ev.target.result, webkitRelativePath: file.webkitRelativePath || file.name })
                          r.onerror = () => res({ name: file.name, size: file.size, text: '', webkitRelativePath: file.webkitRelativePath || file.name })
                          r.readAsText(file)
                        }))
                        Promise.all(readers).then(handleFilesAdded)
                      }}}
                    />
                    <input id="vibe-add-files" type="file" multiple style={{ display: 'none' }}
                      onChange={(e) => { if (e.target.files.length) {
                        const readers = Array.from(e.target.files).map((file) => new Promise((res) => {
                          const r = new FileReader()
                          r.onload = (ev) => res({ name: file.name, size: file.size, text: ev.target.result, webkitRelativePath: file.webkitRelativePath || file.name })
                          r.onerror = () => res({ name: file.name, size: file.size, text: '', webkitRelativePath: file.webkitRelativePath || file.name })
                          r.readAsText(file)
                        }))
                        Promise.all(readers).then(handleFilesAdded)
                      }}}
                    />
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => document.getElementById('vibe-add-folder')?.click()}>
                      + Add folder
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => document.getElementById('vibe-add-files')?.click()}>
                      + Add files
                    </button>
                  </div>
                </>
              )}
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => { setFiles([]); setRuntimeConfirmed(false); setEnvVarsConfirmed(false); setDeployConfigConfirmed(false); setStagedParams(null) }}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={confirmFiles} disabled={files.length === 0}>
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Runtime ── */}
        {step === 2 && (
          <div className="form-section">
            <div className="form-section-head">Step 2 — Runtime</div>
            <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="frow">
                <div className="field">
                  <label>Detected runtime</label>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    background: 'rgba(74,222,128,.07)', border: '1px solid rgba(74,222,128,.18)',
                    borderRadius: 6, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--green)',
                  }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
                    </svg>
                    {detectedRuntime
                      ? `${detectedRuntime.label}${detectedRuntime.id === 'nginx' ? ' — static site' : ''}`
                      : 'Unknown — defaulting to nginx'}
                  </div>
                  <div className="hint">
                    Image: {detectedRuntime?.image || 'nginx:alpine'} &nbsp;·&nbsp; Port: {detectedRuntime?.port || 80} &nbsp;·&nbsp; Workdir: {detectedRuntime?.workDir || '/usr/share/nginx/html'}
                    {detectedRuntime?.id === 'nginx' ? ' — static files served directly' : ' — dependencies installed automatically at deploy time'}
                  </div>
                </div>
              </div>
              <div className="field">
                <label>Start command</label>
                {overrideCmd ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="text"
                      value={startCmd}
                      onChange={(e) => setStartCmd(e.target.value)}
                      placeholder="e.g. node server.js"
                      autoFocus
                      style={{ flex: 1 }}
                    />
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => { setOverrideCmd(false); if (detectedRuntime) setStartCmd(detectedRuntime.defaultCmd(files)) }}>
                      Reset
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div style={{
                      flex: 1, background: 'var(--bg)', border: '1px solid var(--border2)',
                      borderRadius: 6, padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 13,
                      color: 'var(--text-bright)', display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2">
                        <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                      </svg>
                      {startCmd}
                    </div>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOverrideCmd(true)}>
                      Override
                    </button>
                  </div>
                )}
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>← Back</button>
                <button type="button" className="btn btn-primary" onClick={confirmRuntime}>
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: Env Vars (only when .env.example present) ── */}
        {step === 3 && hasEnvExample && (
          <div className="form-section">
            <div className="form-section-head">Step 3 — Environment Variables</div>
            <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="hint" style={{ marginBottom: 4 }}>
                Detected from <span style={{ fontFamily: 'var(--mono)', color: 'var(--amber)' }}>.env.example</span> — enter values to create a real <span style={{ fontFamily: 'var(--mono)' }}>.env</span> at deploy time. The .env file is written to the PV and never committed to git.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {envVars.map((v, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 8, alignItems: 'center' }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
                      background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5,
                      padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{v.key}</div>
                    <input
                      type={SECRET_PATTERN.test(v.key) ? 'password' : 'text'}
                      value={v.value}
                      placeholder={SECRET_PATTERN.test(v.key) ? '••••••••' : 'value'}
                      onChange={(e) => setEnvVars((prev) => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                    />
                    <button type="button" className="btn btn-ghost btn-xs"
                      onClick={() => setEnvVars((prev) => prev.filter((_, j) => j !== i))}
                      style={{ padding: '5px 8px' }}>✕</button>
                  </div>
                ))}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
                onClick={() => setEnvVars((prev) => [...prev, { key: '', value: '' }])}>
                + Add variable
              </button>
              <div className="hint">Keys matching SECRET, KEY, TOKEN, PASSWORD are masked above.</div>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>← Back</button>
                <button type="button" className="btn btn-primary" onClick={confirmEnvVars}>
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 4: Deploy Config ── */}
        {step === 4 && (
          <div className="form-section">
            <div className="form-section-head">Step {hasEnvExample ? 4 : 3} — Deploy</div>
            <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="frow">
                <div className="field">
                  <label>App name</label>
                  <input type="text" value={appName}
                    onChange={(e) => setAppName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                    placeholder="my-app" />
                  <div className="hint">Lowercase, alphanumeric and hyphens</div>
                </div>
                <div className="field">
                  <label>Instances</label>
                  <input type="number" value={instances} min={1} max={20}
                    onChange={(e) => setInstances(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)))} />
                </div>
              </div>
              <div className="frow">
                <div className="field">
                  <label>Deployment target</label>
                  <select value={envId} onChange={(e) => { setEnvId(e.target.value); setNamespace(''); setNsList([]); setManualNs(false); setNsHint({ text: '', tone: 'dim' }) }}>
                    <option value="">— Select —</option>
                    {environments.filter((e) => !isEnvDisabled({ disabledEnvs }, e.Id)).map((e) => (
                      <option key={e.Id} value={String(e.Id)}>{e.Name}</option>
                    ))}
                  </select>
                  <div className="hint">Portainer environment to deploy into</div>
                </div>
                <div className="field">
                  <label>Namespace</label>
                  {!manualNs ? (
                    <select value={namespace} onChange={(e) => setNamespace(e.target.value)} disabled={!envId || nsLoading}>
                      <option value="">{!envId ? 'Select target first...' : nsLoading ? 'Loading namespaces...' : '— Select —'}</option>
                      {nsList.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={manualNsValue}
                      onChange={(e) => setManualNsValue(e.target.value)} placeholder="my-namespace" />
                  )}
                  {nsHint.text && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: nsStatusColor, marginTop: 4 }}>{nsHint.text}</div>
                  )}
                  <div className="hint">Namespace must already exist in the target</div>
                </div>
              </div>
              {perms && (!perms.canDeploy || !perms.canCreatePvc) && (
                <div style={{
                  padding: '12px 14px', background: 'rgba(239,68,68,0.08)',
                  border: '1px solid var(--red)', borderRadius: 8,
                  fontSize: 13, color: 'var(--red)', fontFamily: 'var(--mono)',
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    width="16" height="16" style={{ flexShrink: 0, marginTop: 1 }}>
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <div>
                    {!perms.canDeploy && <div>No permission to create Deployments in namespace &quot;{resolvedNs}&quot;.</div>}
                    {!perms.canCreatePvc && <div>No permission to create PersistentVolumeClaims in namespace &quot;{resolvedNs}&quot;.</div>}
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>Select a different namespace or contact your platform administrator.</div>
                  </div>
                </div>
              )}
              <div className="field">
                <label>Expose as</label>
                <select value={exposeType} onChange={(e) => setExposeType(e.target.value)}>
                  <option value="none">Internal only (ClusterIP)</option>
                  <option value="NodePort">NodePort — expose on cluster node IP + port</option>
                  <option value="LoadBalancer">LoadBalancer — provision external load balancer</option>
                  <option value="Ingress">Ingress — route via ingress controller</option>
                </select>
              </div>
              {exposeType === 'Ingress' && (
                <div className="frow">
                  <div className="field">
                    <label>Hostname</label>
                    <input type="text" value={ingHost} onChange={(e) => setIngHost(e.target.value)} placeholder="app.example.com" />
                  </div>
                  <div className="field">
                    <label>Ingress class</label>
                    <input type="text" value={ingClass} onChange={(e) => setIngClass(e.target.value)} placeholder="nginx" />
                  </div>
                </div>
              )}
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(hasEnvExample ? 3 : 2)}>← Back</button>
                <button type="button" className="btn btn-primary"
                  onClick={confirmDeployConfig}
                  disabled={!appName || !envId || !resolvedNs || !canProceed}>
                  Next: Git Target →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 5: GitOps Target (shared component) ── */}
        {step === 5 && stagedParams && (
          <GitOpsStep
            appName={stagedParams.appName}
            ns={stagedParams.ns}
            envId={stagedParams.envId}
            deployParams={stagedParams}
            onConfirm={handleGitOpsConfirm}
            onBack={() => { setStep(4); setDeployConfigConfirmed(false); setStagedParams(null) }}
            deploying={deploying}
          />
        )}
      </div>
    </div>
  )
}
