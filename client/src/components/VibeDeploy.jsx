import { useEffect, useRef, useState } from 'react'
import { unzip } from 'fflate'
import { Link, useNavigate } from 'react-router-dom'
import { ROUTES } from '../lib/routes.js'
import { listGitTargets } from '../lib/gitTargets.js'
import { useAppStore, visibleEnvironments, isEnvDisabled } from '../store/useAppStore.js'
import { serverFetch } from '../lib/api.js'
import { fetchNamespaceOptions } from '../lib/deployK8s.js'
import { kubeFetch } from '../lib/api.js'
import { checkEnvPermissions } from '../lib/envPermissions.js'
import { GitOpsStep } from './deploy/GitOpsStep.jsx'
import { checkIngress, checkLoadBalancer } from '../lib/readinessChecks.js'
import { manualRefresh, schedulePostDeployRefreshes } from '../services/refreshDeployments.js'

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
    label: 'Node.js 22',
    image: 'node:22',
    detect: (names) => {
      const base = names.map((n) => n.split('/').pop())
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
// ZIP extraction
// ---------------------------------------------------------------------------

async function extractZip(file) {
  const arrayBuffer = await file.arrayBuffer()
  const uint8 = new Uint8Array(arrayBuffer)

  return new Promise((resolve, reject) => {
    unzip(uint8, (err, files) => {
      if (err) { reject(err); return }
      const results = []
      for (const [relPath, data] of Object.entries(files)) {
        if (relPath.endsWith('/')) continue // directory entry
        if (relPath.startsWith('__MACOSX/') || relPath.includes('/__MACOSX/')) continue
        const parts = relPath.split('/')
        const name = parts[parts.length - 1]
        if (!name) continue
        results.push({
          name,
          size: data.length,
          text: new TextDecoder().decode(data),
          webkitRelativePath: relPath,
        })
      }
      resolve(results)
    })
  })
}

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
    const allFiles = Array.from(fileList)
    const zips = allFiles.filter((f) => f.name.toLowerCase().endsWith('.zip'))
    const rest = allFiles.filter((f) => !f.name.toLowerCase().endsWith('.zip'))

    const zipPromises = zips.map((f) => extractZip(f))
    const restPromise = rest.length
      ? Promise.all(rest.map((file) => new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = (e) => resolve({ name: file.name, size: file.size, text: e.target.result, webkitRelativePath: file.webkitRelativePath || file.name })
          reader.onerror = () => resolve({ name: file.name, size: file.size, text: '', webkitRelativePath: file.webkitRelativePath || file.name })
          reader.readAsText(file)
        })))
      : Promise.resolve([])

    Promise.all([restPromise, ...zipPromises])
      .then((groups) => onFiles(groups.flat()))
  }

  async function onDrop(e) {
    e.preventDefault()
    setDragging(false)
    // Use DataTransferItem API for folder support
    const items = e.dataTransfer.items
    if (items && items.length) {
      const entries = Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter(Boolean)
      if (entries.length) {
        // Split zip file entries from everything else
        const zipEntries = entries.filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith('.zip'))
        const otherEntries = entries.filter((entry) => !entry.isFile || !entry.name.toLowerCase().endsWith('.zip'))

        const zipFiles = await Promise.all(
          zipEntries.map((entry) => new Promise((resolve) => entry.file(resolve)))
        )
        const zipResults = await Promise.all(zipFiles.map(extractZip))
        const traversed = otherEntries.length
          ? (await Promise.all(otherEntries.map(traverseEntry))).flat()
          : []

        onFiles([...traversed, ...zipResults.flat()])
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
      className={`vibe-dropzone${dragging ? ' vibe-dropzone--dragging' : ''}`}
    >
      <input ref={folderRef} type="file" webkitdirectory="" multiple style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files.length) readFileList(e.target.files) }} />
      <input ref={filesRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files.length) readFileList(e.target.files) }} />
      <div style={{
        width: 40, height: 40,
        display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px',
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.6">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <div style={{ fontSize: 15, color: 'var(--text)', marginBottom: 14 }}>
        Drop your project folder here
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => folderRef.current?.click()}>
          Upload folder
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => filesRef.current?.click()}>
          Upload files
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
  const [ingressHostMap, setIngressHostMap] = useState({})

  // ---- Step tracking ----
  // 1=files, 2=runtime, 3=envvars, 4=deployconfig, 5=gitops
  const [noGitTargets, setNoGitTargets] = useState(false)
  const [gitTargetsList, setGitTargetsList] = useState([])
  useEffect(() => {
    listGitTargets().then((r) => {
      const list = r?.connections || []
      setNoGitTargets(list.length === 0)
      setGitTargetsList(list)
    }).catch(() => {})
  }, [])

  const [step, setStep] = useState(1)

  // ---- Step 1: files or git source ----
  const [sourceType, setSourceType] = useState('upload') // 'upload' | 'git'
  const [files, setFiles] = useState([])
  // Git source fields
  const [gitSourceTargetId, setGitSourceTargetId] = useState('')
  const [gitSourceBranch, setGitSourceBranch] = useState('main')
  const [gitSourcePath, setGitSourcePath] = useState('')
  const [gitSourceBranches, setGitSourceBranches] = useState([])
  const [gitSourceFetching, setGitSourceFetching] = useState(false)
  const [gitSourceConfirmed, setGitSourceConfirmed] = useState(false)

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
  const instances = 1
  const [exposeType, setExposeType] = useState('NodePort')
  const [svcPort, setSvcPort] = useState('')
  const [ingHost, setIngHost] = useState('')
  const [ingPath, setIngPath] = useState('/')
  const [ingClass, setIngClass] = useState('')
  const [deployConfigConfirmed, setDeployConfigConfirmed] = useState(false)

  // ---- Env capabilities (for expose type filtering) ----
  // null = not yet probed, true = available, false = not available
  const [envCapabilities, setEnvCapabilities] = useState({ ingressOk: null, lbOk: null, probing: false, ingressClasses: [], defaultIngressClass: null })

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
    ? files.find((f) => f.name === 'package.json' || f.name === 'requirements.txt' || f.name === 'Gemfile' || f.name === 'server.js')
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

  // Auto-select environment when only one is available
  useEffect(() => {
    if (envId) return
    const available = environments.filter((e) => !isEnvDisabled({ disabledEnvs }, e.Id))
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
    Promise.all([
      checkIngress(token, envId),
      checkLoadBalancer(token, envId),
    ]).then(([ingressResult, lbResult]) => {
      const defaultClass = ingressResult.defaultClass || (ingressResult.classes?.length === 1 ? ingressResult.classes[0].name : null)
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
    }).catch(() => {
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
      .then(async (r) => {
        if (!r.ok) { setIngressHostMap({}); return }
        const data = await r.json()
        const items = data.items || []
        const adminIngresses = items.filter(
          (item) => item.metadata?.labels?.['managed-by'] !== 'portainer-run'
        )
        // Prefer admin-configured ingresses as the source of truth.
        // Fall back to managed ingresses only if no admin ones exist yet.
        const sources = adminIngresses.length > 0 ? adminIngresses : items
        const usingManaged = adminIngresses.length === 0
        const map = {}
        for (const item of sources) {
          const cls = item.spec?.ingressClassName
            || item.metadata?.annotations?.['kubernetes.io/ingress.class']
            || ''
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
          setNsHint({ text: `${r.namespaces.length} project space${r.namespaces.length !== 1 ? 's' : ''} found`, tone: 'ok' })
        }
      } else {
        setManualNs(true)
        setNsHint({ text: r.error || 'Could not load project spaces', tone: 'err' })
      }
    }).catch(() => {
      setManualNs(true)
      setNsHint({ text: 'Could not load project spaces', tone: 'err' })
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
    if (sourceType === 'upload') {
      if (!files.length) { pushToast('Add at least one file', 'err'); return }
      setStep(hasEnvExample ? 3 : 4)
    } else {
      // git source — already confirmed, runtime detected
      if (!gitSourceConfirmed) { pushToast('Select a git source and fetch files', 'err'); return }
      setStep(hasEnvExample ? 3 : 4)
    }
  }

  async function fetchGitSourceFiles() {
    if (!gitSourceTargetId || !gitSourceBranch) {
      pushToast('Select a git target and branch', 'err'); return
    }
    setGitSourceFetching(true)
    try {
      const pathParam = gitSourcePath ? `&path=${encodeURIComponent(gitSourcePath)}` : ''
      const r = await serverFetch(
        `/api/connections/${gitSourceTargetId}/files?branch=${encodeURIComponent(gitSourceBranch)}${pathParam}`,
      )
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
      // Run runtime detection against file names
      const names = (data.files || []).filter((f) => f.type === 'file').map((f) => f.path)
      const syntheticFiles = names.map((n) => ({ name: n, text: '' }))
      const rt = detectRuntime(syntheticFiles)
      setDetectedRuntime(rt)
      setStartCmd(rt?.startCmd || '')
      setGitSourceConfirmed(true)
      pushToast('Files scanned — ready to deploy', 'ok')
    } catch (e) {
      pushToast(e?.message || 'Failed to fetch files from git', 'err')
    } finally {
      setGitSourceFetching(false)
    }
  }

  async function loadGitSourceBranches(targetId) {
    if (!targetId) return
    try {
      const r = await serverFetch(`/api/connections/${targetId}/branches`)
      const data = await r.json().catch(() => ({}))
      setGitSourceBranches(data.branches || [])
    } catch { setGitSourceBranches([]) }
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
    if (perms && !perms.canDeploy) { pushToast('No deploy permission in this project space', 'err'); return }
    if (perms && !perms.canCreatePvc) { pushToast('No permission to create PersistentVolumeClaims in this project space', 'err'); return }
    if (!envId) { pushToast('Select a target environment', 'err'); return }
    if (!resolvedNs) { pushToast('Select or enter a project space', 'err'); return }

    // Build deploy params for GitOpsStep dry-run + actual deploy
    // Priority: user-entered svcPort > PORT env var > runtime default
    const portEnvVar = envVars.find((v) => v.key === 'PORT')?.value
    const portValue = parseInt(String(svcPort || portEnvVar || detectedRuntime?.port || 80), 10)
    const resolvedPort = isNaN(portValue) ? 80 : portValue

    // Build a single-container spec representing the vibe deploy
    const containerSpec = {
      name: appName,
      image: detectedRuntime?.image || 'node:22',
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
      exposeType: exposeType,
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
        runtimeImage: detectedRuntime?.image || 'node:22',
        startCmd: startCmd.trim(),
        workDir: detectedRuntime?.workDir || '/app',
        envVars: envVars.filter((v) => v.key),
        sourceType,
        // Upload source
        sourceFiles: sourceType === 'upload'
          ? files.map((f) => ({ path: f.webkitRelativePath || f.name, content: f.text }))
          : [],
        // Git source
        gitSource: sourceType === 'git' ? {
          gitTargetId: gitSourceTargetId,
          branch: gitSourceBranch,
          path: gitSourcePath || '',
        } : null,
      },
    }

    setStagedParams(params)
    setDeployConfigConfirmed(true)
    setStep(5)
    if (gitTargetsList.length === 1) {
      const target = gitTargetsList[0]
      void handleGitOpsConfirm({
        gitTargetId: target.id,
        branch: target.payload?.defaultBranch || 'main',
        pathPrefix: target.payload?.pathPrefix || '',
        pollInterval: '5m',
      }, params)
    }
  }

  async function handleGitOpsConfirm({ gitTargetId, branch, pathPrefix, pollInterval }, _params = null) {
    const sp = _params || stagedParams
    if (!sp) return
    setDeploying(true)
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
      pushToast(`${sp.appName} deployed successfully`, 'ok')
      void manualRefresh()
      schedulePostDeployRefreshes()
      navigate(ROUTES.services)
      // Reset form
      setFiles([]); setStep(1); setStagedParams(null)
      setRuntimeConfirmed(false); setEnvVarsConfirmed(false); setDeployConfigConfirmed(false)
      setAppName(''); setEnvId(''); setNamespace('')
      setExposeType('NodePort'); setIngHost(''); setIngPath('/'); setIngClass('')
    } catch (e) {
      pushToast('Deploy failed: ' + (e?.message || 'Unknown error'), 'err')
    } finally {
      setDeploying(false)
    }
  }


  // ---- Render helpers ----

  const VD_STEPS_ALL = [
    { num: 1, label: 'Files' },
    { num: 3, label: 'App settings' },
    { num: 4, label: 'Deploy' },
    { num: 5, label: 'Storage' },
  ]
  const visibleSteps = VD_STEPS_ALL
    .filter((s) => !(s.num === 3 && !hasEnvExample))
    .filter((s) => !(s.num === 5 && gitTargetsList.length === 1))
    .map((s, i) => ({ ...s, displayNum: i + 1 }))
  const displayStep = visibleSteps.find((s) => s.num === step)?.displayNum
    ?? (step >= 5 ? visibleSteps.length + 1 : 1)

  const nsStatusColor = nsHint.tone === 'warn' ? 'var(--amber)'
    : nsHint.tone === 'ok' ? 'var(--green)'
    : nsHint.tone === 'err' ? 'var(--red)' : 'var(--text-dim)'

  // ---- Render ----

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Deploy</div>
          <div className="page-sub">
            Drop the files your AI coding tool generated: we handle git, runtime detection, and deployment.
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
            No git targets configured. Portainer-Run requires a git repository to commit manifests and source files before deploying.{' '}
            <Link to={ROUTES.gitTargets} style={{ color: 'var(--accent)' }}>Set one up in Git Targets</Link> first.
          </span>
        </div>
      )}
        {/* Stepper */}
        <div className="mb-stepper">
          {visibleSteps.map((s, i) => {
            const state = s.displayNum < displayStep ? 'done' : s.displayNum === displayStep ? 'active' : 'idle'
            return (
              <div key={s.num} style={{ display: 'flex', alignItems: 'center' }}>
                <div className={`mb-step mb-step--${state}`}>
                  <div className="mb-step-num">{state === 'done' ? '✓' : s.displayNum}</div>
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

              {/* Source type toggle */}
              <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border2)', borderRadius: 6, overflow: 'hidden', alignSelf: 'flex-start' }}>
                {[['upload', 'Upload files'], ['git', 'From Git repository']].map(([val, label]) => (
                  <button key={val} type="button"
                    onClick={() => { setSourceType(val); setGitSourceConfirmed(false); setDetectedRuntime(null) }}
                    style={{
                      padding: '7px 16px', fontSize: 12, fontFamily: 'var(--mono)', border: 'none', cursor: 'pointer',
                      background: sourceType === val ? 'var(--accent)' : 'transparent',
                      color: sourceType === val ? '#000' : 'var(--text)',
                    }}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Upload source */}
              {sourceType === 'upload' && (
                <>
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
                              (f.name === 'package.json' || f.name === 'requirements.txt' || f.name === 'Gemfile' || f.name === 'server.js') ? 'runtime'
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
                            const allFiles = Array.from(e.target.files)
                            const zips = allFiles.filter((f) => f.name.toLowerCase().endsWith('.zip'))
                            const rest = allFiles.filter((f) => !f.name.toLowerCase().endsWith('.zip'))
                            const zipPromises = zips.map((f) => extractZip(f))
                            const restPromise = rest.length
                              ? Promise.all(rest.map((file) => new Promise((res) => {
                                  const r = new FileReader()
                                  r.onload = (ev) => res({ name: file.name, size: file.size, text: ev.target.result, webkitRelativePath: file.webkitRelativePath || file.name })
                                  r.onerror = () => res({ name: file.name, size: file.size, text: '', webkitRelativePath: file.webkitRelativePath || file.name })
                                  r.readAsText(file)
                                })))
                              : Promise.resolve([])
                            Promise.all([restPromise, ...zipPromises]).then((groups) => handleFilesAdded(groups.flat()))
                          }}}
                        />
                        <input id="vibe-add-files" type="file" multiple style={{ display: 'none' }}
                          onChange={(e) => { if (e.target.files.length) {
                            const allFiles = Array.from(e.target.files)
                            const zips = allFiles.filter((f) => f.name.toLowerCase().endsWith('.zip'))
                            const rest = allFiles.filter((f) => !f.name.toLowerCase().endsWith('.zip'))
                            const zipPromises = zips.map((f) => extractZip(f))
                            const restPromise = rest.length
                              ? Promise.all(rest.map((file) => new Promise((res) => {
                                  const r = new FileReader()
                                  r.onload = (ev) => res({ name: file.name, size: file.size, text: ev.target.result, webkitRelativePath: file.webkitRelativePath || file.name })
                                  r.onerror = () => res({ name: file.name, size: file.size, text: '', webkitRelativePath: file.webkitRelativePath || file.name })
                                  r.readAsText(file)
                                })))
                              : Promise.resolve([])
                            Promise.all([restPromise, ...zipPromises]).then((groups) => handleFilesAdded(groups.flat()))
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
                </>
              )}

              {/* Git source */}
              {sourceType === 'git' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div className="field">
                    <label>Git target</label>
                    <select value={gitSourceTargetId} onChange={(e) => {
                      setGitSourceTargetId(e.target.value)
                      setGitSourceBranches([])
                      setGitSourceBranch('main')
                      setGitSourceConfirmed(false)
                      if (e.target.value) loadGitSourceBranches(e.target.value)
                    }}>
                      <option value="">— Select —</option>
                      {gitTargetsList.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}{t.shared ? ' (shared)' : ''}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Branch</label>
                      {gitSourceBranches.length > 0 ? (
                        <select value={gitSourceBranch} onChange={(e) => { setGitSourceBranch(e.target.value); setGitSourceConfirmed(false) }}>
                          {gitSourceBranches.map((b) => <option key={b} value={b}>{b}</option>)}
                        </select>
                      ) : (
                        <input type="text" value={gitSourceBranch} onChange={(e) => { setGitSourceBranch(e.target.value); setGitSourceConfirmed(false) }} placeholder="main" />
                      )}
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Subfolder path <span className="hint" style={{ textTransform: 'none' }}>(optional, default: repo root)</span></label>
                      <input type="text" value={gitSourcePath} onChange={(e) => { setGitSourcePath(e.target.value); setGitSourceConfirmed(false) }} placeholder="src / leave empty for root" />
                    </div>
                  </div>
                  {gitSourceConfirmed ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: 6, fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--green)' }}>
                      ✓ Files ready to deploy
                      <button type="button" className="btn btn-ghost btn-xs" style={{ marginLeft: 'auto' }} onClick={() => { setGitSourceConfirmed(false); setDetectedRuntime(null) }}>Re-fetch</button>
                    </div>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
                      disabled={!gitSourceTargetId || !gitSourceBranch || gitSourceFetching}
                      onClick={() => void fetchGitSourceFiles()}>
                      {gitSourceFetching ? 'Fetching…' : 'Fetch & detect runtime'}
                    </button>
                  )}
                </div>
              )}

              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => { setFiles([]); setRuntimeConfirmed(false); setEnvVarsConfirmed(false); setDeployConfigConfirmed(false); setStagedParams(null) }}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={confirmFiles}
                  disabled={sourceType === 'upload' ? files.length === 0 : !gitSourceConfirmed}>
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: App settings (only when .env.example present) ── */}
        {step === 3 && hasEnvExample && (
          <div className="form-section">
            <div className="form-section-head">App settings</div>
            <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="hint" style={{ marginBottom: 4 }}>
                Your app needs a few settings — fill in the values below and they will be applied securely at deploy time.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {envVars.map((v, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 8, alignItems: 'center' }}>
                    {v.custom ? (
                      <div className="field" style={{ marginBottom: 0 }}>
                        <input
                          type="text"
                          value={v.key}
                          placeholder="NAME"
                          style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                          onChange={(e) => setEnvVars((prev) => prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                        />
                      </div>
                    ) : (
                      <div style={{
                        fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
                        background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5,
                        padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{v.key}</div>
                    )}
                    <div className="field">
                      <input
                        type={SECRET_PATTERN.test(v.key) ? 'password' : 'text'}
                        value={v.value}
                        placeholder={SECRET_PATTERN.test(v.key) ? '••••••••' : 'value'}
                        onChange={(e) => setEnvVars((prev) => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                      />
                    </div>
                    <button type="button" className="btn btn-ghost btn-xs"
                      onClick={() => setEnvVars((prev) => prev.filter((_, j) => j !== i))}
                      style={{ padding: '5px 8px' }}>✕</button>
                  </div>
                ))}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
                onClick={() => setEnvVars((prev) => [...prev, { key: '', value: '', custom: true }])}>
                + Add variable
              </button>
              <div className="hint">Values marked with •••• are treated as sensitive and hidden from view.</div>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>← Back</button>
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
            <div className="form-section-head">Deploy your app</div>
            <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="frow">
                <div className="field">
                  <label>App name</label>
                  <input type="text" value={appName}
                    onChange={(e) => setAppName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                    placeholder="my-app" />
                  <div className="hint">Lowercase, alphanumeric and hyphens</div>
                </div>
              </div>
              <div className="frow">
                <div className="field">
                  <label>Deployment target</label>
                  {(() => {
                    const availableEnvs = environments.filter((e) => !isEnvDisabled({ disabledEnvs }, e.Id))
                    const locked = availableEnvs.length === 1
                    return locked ? (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        background: 'var(--bg)', border: '1px solid var(--border2)',
                        borderRadius: 6, padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 13,
                        color: 'var(--text-bright)',
                      }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        {availableEnvs[0].Name}
                      </div>
                    ) : (
                      <select value={envId} onChange={(e) => { setEnvId(e.target.value); setNamespace(''); setNsList([]); setManualNs(false); setNsHint({ text: '', tone: 'dim' }) }}>
                        <option value="">— Select —</option>
                        {availableEnvs.map((e) => (
                          <option key={e.Id} value={String(e.Id)}>{e.Name}</option>
                        ))}
                      </select>
                    )
                  })()}
                  <div className="hint">Portainer environment to deploy into</div>
                </div>
                <div className="field">
                  <label>Project space</label>
                  {!manualNs ? (
                    (() => {
                      const locked = nsList.length === 1 && !nsLoading
                      return locked ? (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          background: 'var(--bg)', border: '1px solid var(--border2)',
                          borderRadius: 6, padding: '9px 12px', fontFamily: 'var(--mono)', fontSize: 13,
                          color: 'var(--text-bright)',
                        }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                          </svg>
                          {nsList[0]}
                        </div>
                      ) : (
                        <select value={namespace} onChange={(e) => setNamespace(e.target.value)} disabled={!envId || nsLoading}>
                          <option value="">{!envId ? 'Select target first...' : nsLoading ? 'Loading project spaces...' : '— Select —'}</option>
                          {nsList.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      )
                    })()
                  ) : (
                    <input type="text" value={manualNsValue}
                      onChange={(e) => setManualNsValue(e.target.value)} placeholder="my-project-space" />
                  )}
                  {nsHint.text && (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: nsStatusColor, marginTop: 4 }}>{nsHint.text}</div>
                  )}
                  <div className="hint">Project space must already exist in the target</div>
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
                    {!perms.canDeploy && <div>No permission to create Deployments in project space &quot;{resolvedNs}&quot;.</div>}
                    {!perms.canCreatePvc && <div>No permission to create PersistentVolumeClaims in project space &quot;{resolvedNs}&quot;.</div>}
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>Select a different project space or contact your platform administrator.</div>
                  </div>
                </div>
              )}
              <div className="field">
                <label>Expose as</label>
                <select value={exposeType} onChange={(e) => setExposeType(e.target.value)}
                  disabled={envCapabilities.probing}>
                  <option value="NodePort">Network Accessible - Default, use this unless advised otherwise</option>
                  {(envCapabilities.probing || envCapabilities.lbOk !== false) && (
                    <option value="LoadBalancer">Network Accessible via dedicated IP</option>
                  )}
                  {(envCapabilities.probing || envCapabilities.ingressOk !== false) && (
                    <option value="Ingress">Network Accessible via a URL</option>
                  )}
                </select>
                {!envCapabilities.probing && envId && (envCapabilities.lbOk === false || envCapabilities.ingressOk === false) && (
                  <div className="hint" style={{ marginTop: 4 }}>
                    {[
                      envCapabilities.lbOk === false && 'LoadBalancer',
                      envCapabilities.ingressOk === false && 'Ingress',
                    ].filter(Boolean).join(' and ')} not detected on this cluster — option{(envCapabilities.lbOk === false && envCapabilities.ingressOk === false) ? 's' : ''} hidden
                  </div>
                )}
              </div>
              {exposeType === 'Ingress' && (
                <div className="frow">
                  <div className="field">
                    <label>Hostname</label>
                    {(() => {
                      const activeBaseDomain = ingressHostMap[ingClass] || ''
                      return activeBaseDomain ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                          <input
                            type="text"
                            value={appName}
                            onChange={(e) => setAppName(e.target.value.replace(/[^a-z0-9-]/gi, '-').toLowerCase())}
                            style={{ borderRadius: '6px 0 0 6px', borderRight: 'none', flex: '0 0 auto', width: 140 }}
                          />
                          <span style={{
                            padding: '8px 12px',
                            background: 'var(--surface2)',
                            border: '1px solid var(--border2)',
                            borderRadius: '0 6px 6px 0',
                            fontFamily: 'var(--mono)',
                            fontSize: 13,
                            color: 'var(--text-dim)',
                            whiteSpace: 'nowrap',
                          }}>
                            .{activeBaseDomain}
                          </span>
                        </div>
                      ) : (
                        <input type="text" value={ingHost} onChange={(e) => setIngHost(e.target.value)} placeholder="app.example.com" />
                      )
                    })()}
                  </div>
                  <div className="field">
                    <label>Ingress class</label>
                    {envCapabilities.ingressClasses.length > 1 ? (
                      <select
                        value={ingClass}
                        onChange={(e) => setIngClass(e.target.value)}
                        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: 13, padding: '9px 12px' }}
                      >
                        {envCapabilities.ingressClasses.map((c) => (
                          <option key={c.name} value={c.name}>{c.name}{c.isDefault ? ' (default)' : ''}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={ingClass}
                        onChange={(e) => setIngClass(e.target.value)}
                        placeholder="nginx"
                        readOnly={envCapabilities.ingressClasses.length === 1}
                        style={envCapabilities.ingressClasses.length === 1 ? { opacity: 0.6, cursor: 'default' } : {}}
                      />
                    )}
                  </div>
                </div>
              )}
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(hasEnvExample ? 3 : 1)}>← Back</button>
                <button type="button" className="btn btn-primary"
                  onClick={confirmDeployConfig}
                  disabled={!appName || !envId || !resolvedNs || !canProceed}>
                  {gitTargetsList.length === 1 ? 'Deploy →' : 'Next →'}
                </button>
              </div>
              {(!appName || !envId || !resolvedNs) && (
                <div style={{ textAlign: 'right', marginTop: 6, fontSize: 12, color: 'var(--amber)' }}>
                  {[
                    !appName && 'Enter an app name',
                    !envId && 'Select a deployment target',
                    !resolvedNs && 'Select a project space',
                  ].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Step 5: Deploying (single git target) ── */}
        {step === 5 && gitTargetsList.length === 1 && (
          <div className="form-section">
            <div className="form-section-head">Deploying</div>
            <div className="form-section-body" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '28px 20px' }}>
              <span className="spinner" style={{ width: 18, height: 18, flexShrink: 0 }} />
              <span style={{ color: 'var(--text-dim)', fontSize: 14 }}>
                Deploying your app — this may take a moment…
              </span>
            </div>
          </div>
        )}

        {/* ── Step 5: Storage (multiple git targets) ── */}
        {step === 5 && gitTargetsList.length !== 1 && stagedParams && (
          <GitOpsStep
            appName={stagedParams.appName}
            ns={stagedParams.ns}
            envId={stagedParams.envId}
            onConfirm={handleGitOpsConfirm}
            onBack={() => { setStep(4); setDeployConfigConfirmed(false); setStagedParams(null) }}
            deploying={deploying}
            sectionTitle="Where should we store your app?"
          />
        )}
      </div>
    </div>
  )
}
