import { useEffect, useRef, useState } from 'react'
import { FileText, Upload, X } from 'lucide-react'

import { Button } from '@ds/v3-components/Button/Button'
import {
  FormControl,
  Input,
  NumberInput,
} from '@ds/v3-components/FormField/FormField'
import { Select } from '@ds/v3-components/Select/Select'

import { useAppStore } from '../../store/useAppStore.js'
import { serverFetch } from '../../lib/api.js'
import { restartDeployment } from '../../lib/restartDeployment.js'
import { refreshCache } from '../../services/refreshDeployments.js'
import { errMessage } from '../../lib/errors'
import type { Deployment } from '../../types/k8s'
import {
  readDropEvent,
  readFileList,
  stripCommonRoot,
  type UploadedFile,
} from '../../lib/fileIntake'
import { MONO_FONT, SECRET_PATTERN, Section } from './detailUi'

const ERROR_TEXT: React.CSSProperties = {
  color: 'var(--status-danger, #f04438)',
  fontSize: 12,
  fontFamily: MONO_FONT,
}

/**
 * Edit tab for deployed apps.
 * Lets the user upload a new set of files from Claude, commits them to the
 * existing git source path, then triggers a rollout restart so the init
 * container re-runs and syncs the new files into the PV.
 */
export function VibeEditTab({
  d,
  envId,
  namespace,
  name,
  gitOpsInfo,
  onSaved,
}: {
  d: Deployment
  envId: string
  namespace: string
  name: string
  gitOpsInfo: {
    gitTargetId: string
    gitBranch: string
    gitPath: string
    stackId?: string
  } | null
  onSaved?: () => void
}) {
  const token = useAppStore((s) => s.token)
  const pushToast = useAppStore((s) => s.pushToast)

  const [files, setFiles] = useState<UploadedFile[]>([])
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState('')
  const folderRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)

  // Exposure state — populated from git manifest on mount
  const [exposeType, setExposeType] = useState('NodePort')
  const [svcPort, setSvcPort] = useState(80)
  const [ingHost, setIngHost] = useState('')
  const [ingPath, setIngPath] = useState('/')
  const [ingClass, setIngClass] = useState('')
  const [savingExposure, setSavingExposure] = useState(false)
  const [exposureError, setExposureError] = useState('')

  // Environment variables — populated from the committed manifest on mount
  const [envVars, setEnvVars] = useState<
    { id: string; key: string; value: string }[]
  >([])
  const [envLoaded, setEnvLoaded] = useState(false)
  const [savingEnv, setSavingEnv] = useState(false)
  const [envError, setEnvError] = useState('')

  const gitPath = gitOpsInfo?.gitPath || ''

  useEffect(() => {
    if (!gitOpsInfo?.gitTargetId || !gitOpsInfo?.gitBranch || !gitPath) return
    serverFetch(
      `/api/vibe/manifest-exposure?gitTargetId=${gitOpsInfo.gitTargetId}&branch=${encodeURIComponent(gitOpsInfo.gitBranch)}&gitPath=${encodeURIComponent(gitPath)}`,
    )
      .then((r: Response) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            exposeType?: string
            port?: number
            ingHost?: string
            ingPath?: string
            ingClass?: string
          } | null,
        ) => {
          if (!data) return
          if (data.exposeType) setExposeType(data.exposeType)
          if (data.port) setSvcPort(data.port)
          if (data.ingHost) setIngHost(data.ingHost)
          if (data.ingPath) setIngPath(data.ingPath)
          if (data.ingClass) setIngClass(data.ingClass)
        },
      )
      .catch(() => {})
  }, [gitOpsInfo?.gitTargetId, gitOpsInfo?.gitBranch, gitPath])

  // Load current environment variables from the committed manifest
  useEffect(() => {
    if (!gitOpsInfo?.gitTargetId || !gitOpsInfo?.gitBranch || !gitPath) return
    serverFetch(
      `/api/vibe/manifest-env?gitTargetId=${gitOpsInfo.gitTargetId}&branch=${encodeURIComponent(gitOpsInfo.gitBranch)}&gitPath=${encodeURIComponent(gitPath)}`,
    )
      .then((r: Response) => (r.ok ? r.json() : null))
      .then((data: { env?: { key: string; value: string }[] } | null) => {
        if (data && Array.isArray(data.env)) {
          setEnvVars(
            data.env.map((e: { key: string; value: string }) => ({
              id: crypto.randomUUID(),
              key: e.key,
              value: e.value,
            })),
          )
        }
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
          ingress:
            exposeType === 'Ingress'
              ? {
                  host: ingHost.trim(),
                  path: ingPath.trim() || '/',
                  ingressClass: ingClass.trim(),
                }
              : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      pushToast('Exposure updated — Portainer will reconcile shortly', 'ok')
      setExposureError('')
    } catch (e) {
      setExposureError(errMessage(e) || 'Update failed')
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
          envVars: envVars
            .map(({ id: _id, ...v }) => ({ ...v, key: v.key.trim() }))
            .filter((v) => v.key),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      pushToast('Settings updated — Portainer will reconcile shortly', 'ok')
      setEnvError('')
    } catch (e) {
      setEnvError(errMessage(e) || 'Update failed')
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

  const sourcePath =
    d?.metadata?.annotations?.['portainer-run/vibe-source-path'] || ''
  const gitBranch = gitOpsInfo?.gitBranch || ''

  function mergeFiles(incoming: UploadedFile[]) {
    const stripped = stripCommonRoot(incoming)
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
    setError('')
  }

  function onInputFiles(fileList: FileList | null) {
    if (!fileList || !fileList.length) return
    void readFileList(fileList).then(mergeFiles)
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const result = await readDropEvent(e)
    if (result) mergeFiles(result)
  }

  async function handleUpdate() {
    if (!files.length) {
      setError('Add at least one file to update')
      return
    }
    if (!gitOpsInfo?.gitTargetId || !gitBranch || !sourcePath) {
      setError(
        'Missing git target information — this deployment may not have been created by Portainer-Run',
      )
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
      setError(errMessage(e) || 'Update failed')
    } finally {
      setDeploying(false)
    }
  }

  const hiddenInputs = (
    <>
      <input
        ref={folderRef}
        type="file"
        // @ts-expect-error non-standard folder-picker attribute
        webkitdirectory=""
        multiple
        style={{ display: 'none' }}
        onChange={(e) => onInputFiles(e.target.files)}
      />
      <input
        ref={filesRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => onInputFiles(e.target.files)}
      />
    </>
  )

  return (
    <div style={{ maxWidth: 700 }}>
      {/* Current deployment info */}
      <Section title="Current deployment">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '120px 1fr',
            gap: '6px 16px',
            fontFamily: MONO_FONT,
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--muted)' }}>Runtime image</span>
          <span style={{ color: 'var(--text)' }}>{currentImage}</span>
          <span style={{ color: 'var(--muted)' }}>Start command</span>
          <span style={{ color: 'var(--text)' }}>{currentCmd}</span>
          <span style={{ color: 'var(--muted)' }}>Source path</span>
          <span style={{ color: 'var(--accent, #2e90fa)' }}>
            {sourcePath || '—'}
          </span>
          <span style={{ color: 'var(--muted)' }}>Branch</span>
          <span style={{ color: 'var(--text)' }}>{gitBranch || '—'}</span>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)' }}>
          New files will be committed to the source path above. The app will
          restart and pick them up automatically. Existing app data (databases,
          uploads) is preserved.
        </div>
      </Section>

      {/* Exposure */}
      <Section title="Exposure">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <FormControl label="Expose service as">
            <Select
              value={exposeType}
              onChange={(e) => setExposeType(e.target.value)}
              options={[
                {
                  value: 'NodePort',
                  label:
                    'Network Accessible - Default, use this unless advised otherwise',
                },
                {
                  value: 'LoadBalancer',
                  label: 'Network Accessible via dedicated IP',
                },
                { value: 'Ingress', label: 'Network Accessible via a URL' },
              ]}
            />
          </FormControl>
          {(exposeType === 'NodePort' || exposeType === 'LoadBalancer') && (
            <FormControl label="Port">
              <div style={{ width: 120 }}>
                <NumberInput
                  value={svcPort}
                  onChange={(v) => setSvcPort(Number(v))}
                />
              </div>
            </FormControl>
          )}
          {exposeType === 'Ingress' && (
            <>
              <FormControl label="Hostname">
                <Input
                  type="text"
                  value={ingHost}
                  onChange={(e) => setIngHost(e.target.value)}
                  placeholder="app.example.com"
                />
              </FormControl>
              <div style={{ display: 'flex', gap: 12 }}>
                <FormControl label="Path" style={{ flex: 1 }}>
                  <Input
                    type="text"
                    value={ingPath}
                    onChange={(e) => setIngPath(e.target.value)}
                    placeholder="/"
                  />
                </FormControl>
                <FormControl label="Ingress class" style={{ flex: 1 }}>
                  <Input
                    type="text"
                    value={ingClass}
                    onChange={(e) => setIngClass(e.target.value)}
                    placeholder="nginx"
                  />
                </FormControl>
              </div>
            </>
          )}
          {exposureError && <div style={ERROR_TEXT}>{exposureError}</div>}
          <div>
            <Button
              onClick={() => void handleSaveExposure()}
              disabled={savingExposure}
            >
              {savingExposure ? 'Saving…' : 'Save Exposure'}
            </Button>
          </div>
        </div>
      </Section>

      {/* App settings (environment variables) */}
      <Section title="App settings">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
            Add or adjust the values your app runs with. Saving applies them
            securely and restarts the app.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {envVars.map((v) => (
              <div
                key={v.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 1fr auto',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <Input
                  type="text"
                  value={v.key}
                  placeholder="NAME"
                  style={{ fontFamily: MONO_FONT, fontSize: 12 }}
                  onChange={(e) =>
                    setEnvVars((prev) =>
                      prev.map((x) =>
                        x.id === v.id ? { ...x, key: e.target.value } : x,
                      ),
                    )
                  }
                />
                <Input
                  type={SECRET_PATTERN.test(v.key) ? 'password' : 'text'}
                  value={v.value}
                  placeholder={
                    SECRET_PATTERN.test(v.key) ? '••••••••' : 'value'
                  }
                  onChange={(e) =>
                    setEnvVars((prev) =>
                      prev.map((x) =>
                        x.id === v.id ? { ...x, value: e.target.value } : x,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  aria-label="Remove variable"
                  onClick={() =>
                    setEnvVars((prev) => prev.filter((x) => x.id !== v.id))
                  }
                >
                  <X size={12} />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            style={{ alignSelf: 'flex-start' }}
            onClick={() =>
              setEnvVars((prev) => [
                ...prev,
                { id: crypto.randomUUID(), key: '', value: '' },
              ])
            }
          >
            + Add variable
          </Button>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Values marked with •••• are treated as sensitive and hidden from
            view.
          </div>
          {envError && <div style={ERROR_TEXT}>{envError}</div>}
          <div>
            <Button
              onClick={() => void handleSaveEnv()}
              disabled={savingEnv || !envLoaded}
            >
              {savingEnv ? 'Saving…' : 'Save Settings'}
            </Button>
          </div>
        </div>
      </Section>

      {/* File upload */}
      <Section title="Upload updated files">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {files.length === 0 ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              style={{
                border: '1.5px dashed var(--border)',
                borderRadius: 8,
                padding: '32px 20px',
                textAlign: 'center',
              }}
            >
              {hiddenInputs}
              <Upload
                size={18}
                style={{ marginBottom: 8, color: 'var(--muted)' }}
              />
              <div
                style={{ fontSize: 13, color: 'var(--text)', marginBottom: 10 }}
              >
                Drop a folder here, or select below
              </div>
              <div
                style={{ display: 'flex', gap: 8, justifyContent: 'center' }}
              >
                <Button
                  variant="ghost"
                  onClick={() => folderRef.current?.click()}
                >
                  Select folder
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => filesRef.current?.click()}
                >
                  Select files
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {files.length} file{files.length !== 1 ? 's' : ''} selected
                </span>
                <Button variant="ghost" onClick={() => setFiles([])}>
                  Remove all
                </Button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {files.map((f, i) => (
                  <div
                    key={f.webkitRelativePath || f.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '6px 10px',
                    }}
                  >
                    <FileText
                      size={11}
                      style={{ color: 'var(--accent, #2e90fa)', flexShrink: 0 }}
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
                      {f.webkitRelativePath && f.webkitRelativePath !== f.name
                        ? f.webkitRelativePath
                        : f.name}
                    </span>
                    <span
                      style={{
                        fontFamily: MONO_FONT,
                        fontSize: 10,
                        color: 'var(--muted)',
                        flexShrink: 0,
                      }}
                    >
                      {(f.size / 1024).toFixed(1)} KB
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setFiles((p) => p.filter((_, j) => j !== i))
                      }
                      aria-label={`Remove ${f.name}`}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--muted)',
                        display: 'flex',
                        padding: 2,
                        flexShrink: 0,
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {hiddenInputs}
                <Button
                  variant="ghost"
                  onClick={() => folderRef.current?.click()}
                >
                  + Add folder
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => filesRef.current?.click()}
                >
                  + Add files
                </Button>
              </div>
            </>
          )}

          {error && <div style={{ ...ERROR_TEXT, fontSize: 13 }}>{error}</div>}

          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              marginTop: 4,
            }}
          >
            <Button
              variant="ghost"
              onClick={() => {
                setFiles([])
                setError('')
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleUpdate()}
              disabled={deploying || files.length === 0}
            >
              {deploying ? 'Updating…' : 'Commit & Restart'}
            </Button>
          </div>
        </div>
      </Section>
    </div>
  )
}
