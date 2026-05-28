import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore.js'
import { gitOpsFetchManifest, gitOpsUpdate } from '../../lib/gitTargets.js'
import { yamlToManifestBuilder } from '../../lib/yamlToManifestBuilder.js'
import { defaultManifestBuilderState } from '../../lib/manifestBuilderModel.js'
import { serializeManifestBuilder } from '../../lib/manifestBuilderSerialize.client.js'
import {
  fetchSecretsInNamespace,
  fetchStorageClasses,
  fetchConfigMapsInNamespace,
  fetchImagePullSecrets,
  detectClusterGpuType,
  fetchNamespaceQuota,
} from '../../lib/deployK8s.js'
import { MBStep2App } from '../deployManifest/sections/MBStep2App.jsx'
import { refreshCache } from '../../services/refreshDeployments.js'

/**
 * Edit tab for Manifest Builder deployments.
 * Fetches the manifest from Git, parses into form state, renders MB form sections.
 * Save commits the updated manifest back to Git — Portainer reconciles.
 */
export default function MBEditTab({ envId, namespace, gitOpsInfo, onSaved }) {
  const token = useAppStore((s) => s.token)
  const pushToast = useAppStore((s) => s.pushToast)

  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [warnings, setWarnings] = useState([])
  const [form, setForm] = useState(defaultManifestBuilderState)
  const [saving, setSaving] = useState(false)

  // Namespace-derived data
  const [secretList, setSecretList] = useState([])
  const [configMapList, setConfigMapList] = useState([])
  const [pullSecrets, setPullSecrets] = useState([])
  const [storageClasses, setStorageClasses] = useState([])
  const [gpuInfo, setGpuInfo] = useState({ key: 'nvidia.com/gpu', label: '', warn: undefined })
  const [gpuAvailable, setGpuAvailable] = useState(false)
  const [nsQuota, setNsQuota] = useState({ requiresLimits: false, requiresRequests: false })

  const patch = (partial) => setForm((f) => ({ ...f, ...partial }))

  // Fetch manifest from Git and parse into form state
  useEffect(() => {
    if (!gitOpsInfo) return
    let cancel = false
    setLoading(true)
    setLoadErr('')

    void (async () => {
      try {
        const { content } = await gitOpsFetchManifest({
          gitTargetId: gitOpsInfo.gitTargetId,
          branch: gitOpsInfo.gitBranch,
          gitPath: gitOpsInfo.gitPath,
        })

        if (cancel) return
        const { state, warnings: w } = yamlToManifestBuilder(content)

        if (!state) {
          setLoadErr('Could not parse manifest from Git — ' + (w[0] || 'unknown error'))
          return
        }

        setWarnings(w)
        setForm((f) => ({
          ...f,
          ...state,
          envId,
          namespace,
        }))
      } catch (e) {
        if (!cancel) setLoadErr('Failed to fetch manifest from Git: ' + (e?.message || String(e)))
      } finally {
        if (!cancel) setLoading(false)
      }
    })()

    return () => { cancel = true }
  }, [gitOpsInfo?.gitTargetId, gitOpsInfo?.gitBranch, gitOpsInfo?.gitPath, envId, namespace])

  // Load namespace-derived data
  useEffect(() => {
    if (!envId || !token || !namespace) return
    let cancel = false
    void Promise.all([
      fetchNamespaceQuota(token, envId, namespace).then((q) => { if (!cancel) setNsQuota(q) }),
      fetchSecretsInNamespace(token, envId, namespace).then((s) => {
        if (cancel) return
        setSecretList(s.map((x) => ({ name: x.metadata?.name || x.name, keys: Object.keys(x.data || {}) })))
      }),
      fetchConfigMapsInNamespace(token, envId, namespace).then((c) => { if (!cancel) setConfigMapList(c) }),
      fetchImagePullSecrets(token, envId, namespace).then((p) => { if (!cancel) setPullSecrets(p) }),
      fetchStorageClasses(token, envId).then((sc) => {
        if (cancel) return
        setStorageClasses((sc || []).map((c) => c.metadata.name))
      }),
      detectClusterGpuType(token, envId).then((g) => {
        if (cancel) return
        setGpuInfo(g)
        setGpuAvailable(Boolean(g.key && !g.warn))
      }),
    ])
    return () => { cancel = true }
  }, [envId, token, namespace])

  async function handleSave() {
    setSaving(true)
    try {
      const yaml = serializeManifestBuilder(
        { ...form, namespace },
        {
          gitTargetId: gitOpsInfo.gitTargetId,
          gitBranch: gitOpsInfo.gitBranch,
          gitPath: gitOpsInfo.gitPath,
        }
      )

      await gitOpsUpdate({
        gitTargetId: gitOpsInfo.gitTargetId,
        branch: gitOpsInfo.gitBranch,
        gitPath: gitOpsInfo.gitPath,
        // For the update endpoint we send the YAML directly
        deployParams: { _yamlOverride: yaml, appName: form.appName, ns: namespace },
      })

      pushToast('Manifest committed — Portainer will apply the update automatically', 'ok')
      setTimeout(() => void refreshCache(false), 1500)
      await onSaved()
    } catch (e) {
      pushToast('Save failed: ' + (e?.message || String(e)), 'err')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="loading-row"><div className="spinner" /> Loading manifest from Git…</div>
  if (loadErr) return <p style={{ color: 'var(--red)', fontSize: 13 }}>{loadErr}</p>

  return (
    <div style={{ maxWidth: 900 }}>
      {/* GitOps badge */}
      <div style={{
        marginBottom: 16, padding: '10px 14px',
        background: 'var(--surface2, var(--bg2))',
        border: '1px solid var(--border)', borderRadius: 6,
        fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
          width="14" height="14" style={{ flexShrink: 0, color: 'var(--accent)' }}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
        <span>
          <span style={{ color: 'var(--accent)' }}>GitOps managed</span>
          {' — '}loaded from <code>{gitOpsInfo.gitPath}</code> on <code>{gitOpsInfo.gitBranch}</code>. Saving commits an updated manifest.
        </span>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div style={{
          marginBottom: 16, padding: '10px 14px',
          background: 'rgba(251,191,36,0.08)', border: '1px solid var(--amber)',
          borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
            Unsupported fields — preserved in Git, not editable here
          </div>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>! {w}</div>
          ))}
        </div>
      )}

      {/* MB form sections */}
      <MBStep2App
        form={form}
        patch={patch}
        secretList={secretList}
        configMapList={configMapList}
        pullSecrets={pullSecrets}
        storageClasses={storageClasses}
        gpuInfo={gpuInfo}
        gpuAvailable={gpuAvailable}
        nsQuota={nsQuota}
        onNext={handleSave}
        onBack={null}
        saveMode
      />

      <div className="form-actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Committing…' : 'Commit changes'}
        </button>
      </div>
    </div>
  )
}
