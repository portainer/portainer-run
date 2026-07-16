import { useEffect, useRef, useState } from 'react'
import { unzip } from 'fflate'

// ZIP extraction (mirrors VibeDeploy.jsx)
async function extractZip(file) {
  const arrayBuffer = await file.arrayBuffer()
  const uint8 = new Uint8Array(arrayBuffer)
  return new Promise((resolve, reject) => {
    unzip(uint8, (err, files) => {
      if (err) { reject(err); return }
      const results = []
      for (const [relPath, data] of Object.entries(files)) {
        if (relPath.endsWith('/')) continue
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

// Folder traversal helpers (mirrors VibeDeploy.jsx)
function readFileEntry(entry) {
  return new Promise((resolve) => {
    entry.file((file) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve({ name: file.name, size: file.size, text: e.target.result, webkitRelativePath: entry.fullPath.replace(/^\//, '') })
      reader.onerror = () => resolve({ name: file.name, size: file.size, text: '', webkitRelativePath: entry.fullPath.replace(/^\//, '') })
      reader.readAsText(file)
    })
  })
}
function readDirEntry(dirEntry) {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader()
    const all = []
    function batch() { reader.readEntries((entries) => { if (!entries.length) { resolve(all); return }; all.push(...entries); batch() }) }
    batch()
  })
}
async function traverseEntry(entry) {
  if (entry.isFile) return [await readFileEntry(entry)]
  if (entry.isDirectory) { const ch = await readDirEntry(entry); return (await Promise.all(ch.map(traverseEntry))).flat() }
  return []
}
import { useAppStore } from '../../store/useAppStore.js'
import { serverFetch } from '../../lib/api.js'
import { restartDeployment } from '../../lib/restartDeployment.js'
import { refreshCache } from '../../services/refreshDeployments.js'

// Mirrors the deploy form: values whose key looks sensitive are masked.
const SECRET_PATTERN = /SECRET|KEY|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL/i

/**
 * Edit tab for deployed apps.
 * Lets the user upload a new set of files from Claude, commits them to the
 * existing git source path, then triggers a rollout restart so the init
 * container re-runs and syncs the new files into the PV.
 *
 * @param {object} props
 * @param {object} props.d          raw Kubernetes Deployment object
 * @param {string} props.envId
 * @param {string} props.namespace
 * @param {string} props.name
 * @param {object} props.gitOpsInfo { gitTargetId, gitBranch, gitPath, stackId }
 * @param {() => void} props.onSaved
 */
export default function VibeEditTab({ d, envId, namespace, name, gitOpsInfo, onSaved }) {
  const token = useAppStore((s) => s.token)
  const pushToast = useAppStore((s) => s.pushToast)

  const [files, setFiles] = useState([])
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState('')
  const folderRef = useRef(null)
  const filesRef = useRef(null)

  // Exposure state — populated from git manifest on mount
  const [exposeType, setExposeType] = useState('NodePort')
  const [svcPort, setSvcPort] = useState(80)
  const [ingHost, setIngHost] = useState('')
  const [ingPath, setIngPath] = useState('/')
  const [ingClass, setIngClass] = useState('')
  const [savingExposure, setSavingExposure] = useState(false)
  const [exposureError, setExposureError] = useState('')

  // Environment variables — populated from the committed manifest on mount
  const [envVars, setEnvVars] = useState([]) // [{ key, value }]
  const [envLoaded, setEnvLoaded] = useState(false)
  const [savingEnv, setSavingEnv] = useState(false)
  const [envError, setEnvError] = useState('')

  const gitPath = gitOpsInfo?.gitPath || ''

  useEffect(() => {
    if (!gitOpsInfo?.gitTargetId || !gitOpsInfo?.gitBranch || !gitPath) return
    serverFetch(`/api/vibe/manifest-exposure?gitTargetId=${gitOpsInfo.gitTargetId}&branch=${encodeURIComponent(gitOpsInfo.gitBranch)}&gitPath=${encodeURIComponent(gitPath)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return
        if (data.exposeType) setExposeType(data.exposeType)
        if (data.port) setSvcPort(data.port)
        if (data.ingHost) setIngHost(data.ingHost)
        if (data.ingPath) setIngPath(data.ingPath)
        if (data.ingClass) setIngClass(data.ingClass)
      })
      .catch(() => {})
  }, [gitOpsInfo?.gitTargetId, gitOpsInfo?.gitBranch, gitPath])

  // Load current environment variables from the committed manifest
  useEffect(() => {
    if (!gitOpsInfo?.gitTargetId || !gitOpsInfo?.gitBranch || !gitPath) return
    serverFetch(`/api/vibe/manifest-env?gitTargetId=${gitOpsInfo.gitTargetId}&branch=${encodeURIComponent(gitOpsInfo.gitBranch)}&gitPath=${encodeURIComponent(gitPath)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data && Array.isArray(data.env)) setEnvVars(data.env)
        setEnvLoaded(true)
      })
      .catch(() => setEnvLoaded(true))
  }, [gitOpsInfo?.gitTargetId, gitOpsInfo?.gitBranch, gitPath])

  async function handleSaveExposure() {
    if (!gitOpsInfo?.gitTargetId || !gitPath) {
      setExposureError('Missing git target information')
      return
    }
    setSavingExposure(true)
    setExposureError('')
    try {
      const res = await serverFetch('/api/vibe/update-exposure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gitTargetId: gitOpsInfo.gitTargetId,
          branch: gitOpsInfo.gitBranch,
          gitPath,
          appName: name,
          ns: namespace,
          exposeType,
          port: svcPort,
          ingress: exposeType === 'Ingress' ? { host: ingHost, path: ingPath, ingressClass: ingClass } : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      pushToast('Exposure updated — Portainer will reconcile shortly', 'ok')
      setExposureError('')
    } catch (e) {
      setExposureError(e?.message || 'Update failed')
    } finally {
      setSavingExposure(false)
    }
  }

  async function handleSaveEnv() {
    if (!gitOpsInfo?.gitTargetId || !gitPath) {
      setEnvError('Missing git target information')
      return
    }
    setSavingEnv(true)
    setEnvError('')
    try {
      const res = await serverFetch('/api/vibe/update-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gitTargetId: gitOpsInfo.gitTargetId,
          branch: gitOpsInfo.gitBranch,
          gitPath,
          envId,
          ns: namespace,
          envVars: envVars.filter((v) => v.key && v.key.trim()),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      pushToast('Settings updated — Portainer will reconcile shortly', 'ok')
      setEnvError('')
    } catch (e) {
      setEnvError(e?.message || 'Update failed')
    } finally {
      setSavingEnv(false)
    }
  }

  // Read current runtime from live deployment
  const containers = d?.spec?.template?.spec?.containers || []
  const mainContainer = containers.find((c) => c.name === name) || containers[0]
  const currentImage = mainContainer?.image || '—'
  const currentCmd = mainContainer?.command
    ? mainContainer.command.join(' ')
    : '—'

  const sourcePath = d?.metadata?.annotations?.['portainer-run/vibe-source-path'] || ''
  const gitBranch = gitOpsInfo?.gitBranch || ''

  function stripCommonRoot(files) {
    if (!files.length) return files
    const paths = files.map((f) => f.webkitRelativePath || f.name)
    const firstSeg = paths[0].split('/')[0]
    const allSameRoot = paths.every((p) => p.startsWith(firstSeg + '/'))
    if (!allSameRoot) return files
    return files.map((f) => ({ ...f, webkitRelativePath: (f.webkitRelativePath || f.name).slice(firstSeg.length + 1) }))
  }

  function mergeFiles(incoming) {
    const stripped = stripCommonRoot(incoming)
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.webkitRelativePath || f.name))
      const merged = [...prev]
      for (const f of stripped) {
        const key = f.webkitRelativePath || f.name
        if (!existing.has(key)) { merged.push(f); existing.add(key) }
      }
      return merged
    })
    setError('')
  }

  function readFileList(fileList) {
    const allFiles = Array.from(fileList)
    const zips = allFiles.filter((f) => f.name.toLowerCase().endsWith('.zip'))
    const rest = allFiles.filter((f) => !f.name.toLowerCase().endsWith('.zip'))

    const restPromise = Promise.all(rest.map((file) => new Promise((res) => {
      const r = new FileReader()
      r.onload = (e) => res({ name: file.name, size: file.size, text: e.target.result, webkitRelativePath: file.webkitRelativePath || file.name })
      r.onerror = () => res({ name: file.name, size: file.size, text: '', webkitRelativePath: file.webkitRelativePath || file.name })
      r.readAsText(file)
    })))

    const zipPromises = zips.map((f) => extractZip(f))
    Promise.all([restPromise, ...zipPromises]).then((groups) => mergeFiles(groups.flat()))
  }

  async function onDrop(e) {
    e.preventDefault()
    const items = e.dataTransfer.items
    if (items && items.length) {
      const entries = Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter(Boolean)
      if (entries.length) {
        const zipEntries = entries.filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith('.zip'))
        const otherEntries = entries.filter((entry) => !entry.isFile || !entry.name.toLowerCase().endsWith('.zip'))
        const zipFiles = await Promise.all(zipEntries.map((entry) => new Promise((resolve) => entry.file(resolve))))
        const zipResults = await Promise.all(zipFiles.map(extractZip))
        const traversed = (await Promise.all(otherEntries.map(traverseEntry))).flat()
        mergeFiles([...traversed, ...zipResults.flat()])
        return
      }
    }
    if (e.dataTransfer.files.length) readFileList(e.dataTransfer.files)
  }

  async function handleUpdate() {
    if (!files.length) { setError('Add at least one file to update'); return }
    if (!gitOpsInfo?.gitTargetId || !gitBranch || !sourcePath) {
      setError('Missing git target information — this deployment may not have been created by Portainer-Run')
      return
    }

    setDeploying(true)
    setError('')
    try {
      // 1. Commit new source files to git
      const res = await serverFetch('/api/vibe/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gitTargetId: gitOpsInfo.gitTargetId,
          branch: gitBranch,
          sourcePath,
          sourceFiles: files.map((f) => ({
            path: f.webkitRelativePath || f.name,
            content: f.text,
          })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)

      // 2. Trigger rollout restart so init container re-runs
      await restartDeployment(token, envId, namespace, name)

      pushToast(`${name} updated — restarting to pick up new files`, 'ok')
      setFiles([])
      await refreshCache(false)
      onSaved?.()
    } catch (e) {
      setError(e?.message || 'Update failed')
    } finally {
      setDeploying(false)
    }
  }

  return (
    <div className="deploy-form" style={{ maxWidth: 700 }}>

      {/* Current deployment info */}
      <div className="form-section" style={{ marginBottom: 16 }}>
        <div className="form-section-head">Current deployment</div>
        <div className="form-section-body">
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '6px 16px', fontFamily: 'var(--mono)', fontSize: 12 }}>
            <span style={{ color: 'var(--text-dim)' }}>Runtime image</span>
            <span style={{ color: 'var(--text-bright)' }}>{currentImage}</span>
            <span style={{ color: 'var(--text-dim)' }}>Start command</span>
            <span style={{ color: 'var(--text-bright)' }}>{currentCmd}</span>
            <span style={{ color: 'var(--text-dim)' }}>Source path</span>
            <span style={{ color: 'var(--accent)' }}>{sourcePath || '—'}</span>
            <span style={{ color: 'var(--text-dim)' }}>Branch</span>
            <span style={{ color: 'var(--text-bright)' }}>{gitBranch || '—'}</span>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            New files will be committed to the source path above. The app will restart and pick them up automatically.
            Existing app data (databases, uploads) is preserved.
          </div>
        </div>
      </div>

      {/* Exposure */}
      <div className="form-section" style={{ marginBottom: 16 }}>
        <div className="form-section-head">Exposure</div>
        <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Expose service as</label>
            <select value={exposeType} onChange={(e) => setExposeType(e.target.value)}>
              <option value="NodePort">Network Accessible - Default, use this unless advised otherwise</option>
              <option value="LoadBalancer">Network Accessible via dedicated IP</option>
              <option value="Ingress">Network Accessible via a URL</option>
            </select>
          </div>
          {(exposeType === 'NodePort' || exposeType === 'LoadBalancer') && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Port</label>
              <input type="number" value={svcPort} onChange={(e) => setSvcPort(Number(e.target.value))} style={{ width: 120 }} />
            </div>
          )}
          {exposeType === 'Ingress' && (
            <>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Hostname</label>
                <input type="text" value={ingHost} onChange={(e) => setIngHost(e.target.value)} placeholder="app.example.com" />
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                  <label>Path</label>
                  <input type="text" value={ingPath} onChange={(e) => setIngPath(e.target.value)} placeholder="/" />
                </div>
                <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                  <label>Ingress class</label>
                  <input type="text" value={ingClass} onChange={(e) => setIngClass(e.target.value)} placeholder="nginx" />
                </div>
              </div>
            </>
          )}
          {exposureError && <div style={{ color: 'var(--red)', fontSize: 12, fontFamily: 'var(--mono)' }}>{exposureError}</div>}
          <div>
            <button type="button" className="btn btn-primary btn-sm"
              onClick={() => void handleSaveExposure()} disabled={savingExposure}>
              {savingExposure ? 'Saving…' : 'Save Exposure'}
            </button>
          </div>
        </div>
      </div>

      {/* App settings (environment variables) */}
      <div className="form-section" style={{ marginBottom: 16 }}>
        <div className="form-section-head">App settings</div>
        <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="hint" style={{ marginBottom: 4 }}>
            Add or adjust the values your app runs with. Saving applies them securely and restarts the app.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {envVars.map((v, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 8, alignItems: 'center' }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <input
                    type="text"
                    value={v.key}
                    placeholder="NAME"
                    style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                    onChange={(e) => setEnvVars((prev) => prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                  />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
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
            onClick={() => setEnvVars((prev) => [...prev, { key: '', value: '' }])}>
            + Add variable
          </button>
          <div className="hint">Values marked with •••• are treated as sensitive and hidden from view.</div>
          {envError && <div style={{ color: 'var(--red)', fontSize: 12, fontFamily: 'var(--mono)' }}>{envError}</div>}
          <div>
            <button type="button" className="btn btn-primary btn-sm"
              onClick={() => void handleSaveEnv()} disabled={savingEnv || !envLoaded}>
              {savingEnv ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        </div>
      </div>

      {/* File upload */}
      <div className="form-section">
        <div className="form-section-head">Upload updated files</div>
        <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {files.length === 0 ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              style={{ border: '1.5px dashed var(--border2)', borderRadius: 8, padding: '32px 20px', textAlign: 'center' }}
            >
              <input ref={folderRef} type="file" webkitdirectory="" multiple style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files.length) readFileList(e.target.files) }} />
              <input ref={filesRef} type="file" multiple style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files.length) readFileList(e.target.files) }} />
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" style={{ marginBottom: 8 }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 10 }}>Drop a folder here, or select below</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => folderRef.current?.click()}>Select folder</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => filesRef.current?.click()}>Select files</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="hint">{files.length} file{files.length !== 1 ? 's' : ''} selected</span>
                <button type="button" className="btn btn-ghost btn-xs"
                  onClick={() => setFiles([])}>Remove all</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {files.map((f, i) => (
                  <div key={f.webkitRelativePath || f.name} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: 'var(--bg)', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '6px 10px',
                  }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" style={{ flexShrink: 0 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16h12V8z" /><polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.webkitRelativePath && f.webkitRelativePath !== f.name ? f.webkitRelativePath : f.name}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--subtle)', flexShrink: 0 }}>
                      {(f.size / 1024).toFixed(1)} KB
                    </span>
                    <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--subtle)', display: 'flex', padding: 2, flexShrink: 0 }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input ref={folderRef} type="file" webkitdirectory="" multiple style={{ display: 'none' }}
                  onChange={(e) => { if (e.target.files.length) readFileList(e.target.files) }} />
                <input ref={filesRef} type="file" multiple style={{ display: 'none' }}
                  onChange={(e) => { if (e.target.files.length) readFileList(e.target.files) }} />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => folderRef.current?.click()}>+ Add folder</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => filesRef.current?.click()}>+ Add files</button>
              </div>
            </>
          )}

          {error && (
            <div style={{ color: 'var(--red)', fontSize: 13, fontFamily: 'var(--mono)' }}>{error}</div>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => { setFiles([]); setError('') }}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary"
              onClick={() => void handleUpdate()}
              disabled={deploying || files.length === 0}>
              {deploying ? 'Updating…' : 'Commit & Restart'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
