import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  applyDeploymentFormUpdate,
  buildK8sContainer,
  detectClusterGpuType,
  fetchNamespaceQuota,
  fetchSecretsInNamespace,
  fetchStorageClasses,
  readVolumeDefForDeploy,
} from '../../lib/deployK8s.js'
import { createContainer, withDefaultCnames } from '../../lib/deployFormModel.js'
import { loadDeployFormFromCluster } from '../../lib/deployFormLoadFromCluster.js'
import { useAppStore, isEnvDisabled } from '../../store/useAppStore.js'
import { refreshCache } from '../../services/refreshDeployments.js'
import { gitOpsUpdate } from '../../lib/gitTargets.js'
import {
  DeployContainersFormList,
  DeployExposureFormFields,
  DeployNameAndInstancesRow,
} from '../deploy/DeployFormSections.jsx'

/**
 * Read GitOps annotations from a Deployment object.
 * Returns null if this deployment was not created via GitOps.
 *
 * @param {object} deployment  raw Kubernetes Deployment object
 * @returns {{ gitTargetId: string, gitBranch: string, gitPath: string, stackId?: string } | null}
 */
function readGitOpsAnnotations(deployment) {
  const ann = deployment?.metadata?.annotations || {}
  const gitTargetId = ann['portainer-run/git-target-id']
  const gitBranch = ann['portainer-run/git-branch']
  const gitPath = ann['portainer-run/git-path']
  if (!gitTargetId || !gitBranch || !gitPath) return null
  return { gitTargetId, gitBranch, gitPath, stackId: ann['portainer-run/stack-id'] }
}

/**
 * @param {object} props
 * @param {object} props.d deployment
 * @param {string} props.envId
 * @param {string} props.namespace
 * @param {string} props.name
 * @param {() => Promise<void> | void} props.onSaved
 */
export default function ServiceDetailEditTab({ d, envId, namespace, name, onSaved }) {
  const location = useLocation()
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const pushToast = useAppStore((s) => s.pushToast)

  const [loadErr, setLoadErr] = useState('')
  const [formLoading, setFormLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [instances, setInstances] = useState(1)
  const [exposeType, setExposeType] = useState('none')
  const [svcPorts, setSvcPorts] = useState(['80'])
  const [ingHost, setIngHost] = useState('')
  const [ingPath, setIngPath] = useState('/')
  const [ingPort, setIngPort] = useState(80)
  const [ingClass, setIngClass] = useState('')
  const [containers, setContainers] = useState(() => [createContainer(true)])
  const [namespaceSecrets, setNamespaceSecrets] = useState([])
  const [scItems, setScItems] = useState([])
  const assistantPrefillDone = useRef(null)

  // Detect GitOps mode from deployment annotations
  const gitOpsInfo = useMemo(() => readGitOpsAnnotations(d), [d])
  const isGitOps = Boolean(gitOpsInfo)

  const resourceKey = d?.metadata?.uid + '@' + (d?.metadata?.resourceVersion || '')
  const [nsQuota, setNsQuota] = useState({ requiresLimits: false, requiresRequests: false })

  useEffect(() => {
    if (!token || !envId || !namespace) return
    void fetchNamespaceQuota(token, envId, namespace).then(setNsQuota)
  }, [token, envId, namespace])

  useEffect(() => {
    if (!token || !envId || !namespace || !name) return
    let cancel = false
    setFormLoading(true); setLoadErr('')
    void (async () => {
      try {
        const loaded = await loadDeployFormFromCluster(token, envId, namespace, name)
        if (cancel) return
        setInstances(loaded.instances); setExposeType(loaded.exposeType)
        setSvcPorts(loaded.svcPorts); setIngHost(loaded.ingHost)
        setIngPath(loaded.ingPath); setIngPort(loaded.ingPort); setIngClass(loaded.ingClass)
        if (loaded.containers?.length) setContainers(loaded.containers)
        else setContainers([createContainer(true)])
      } catch (e) {
        if (!cancel) setLoadErr(e?.message || 'Could not load deployment for editing')
      } finally {
        if (!cancel) setFormLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [token, envId, namespace, name, resourceKey])

  useEffect(() => {
    if (formLoading) return
    const n = location.state?.assistantPrefillInstances
    if (typeof n !== 'number' || n < 0 || n > 100) { assistantPrefillDone.current = null; return }
    if (assistantPrefillDone.current === n) return
    assistantPrefillDone.current = n
    setInstances(n)
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: { ...location.state, assistantPrefillInstances: undefined } },
    )
  }, [formLoading, location.hash, location.pathname, location.search, location.state, navigate])

  useEffect(() => {
    if (formLoading || !envId || !token || !namespace) { setNamespaceSecrets([]); return }
    let cancel = false
    void (async () => {
      const items = await fetchSecretsInNamespace(token, envId, namespace)
      if (cancel) return
      setNamespaceSecrets(items.map((s) => ({ name: s.metadata.name, keys: Object.keys(s.data || {}) })))
    })()
    return () => { cancel = true }
  }, [formLoading, envId, token, namespace, resourceKey])

  const anyVolume = useMemo(() => containers.some((c) => c.volumeOn), [containers])
  const anyGpu = useMemo(() => containers.some((c) => c.gpuEnabled), [containers])

  useEffect(() => {
    if (formLoading || !envId || !token || !anyVolume) { if (!anyVolume) setScItems([]); return }
    let cancel = false
    void (async () => {
      try {
        const items = await fetchStorageClasses(token, envId)
        if (cancel) return
        setScItems((items || []).map((sc) => sc.metadata.name))
        const def = (items || []).find((sc) => sc.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true')
        if (def) setContainers((prev) => prev.map((c) => (c.volumeOn && !c.volClass ? { ...c, volClass: def.metadata.name } : c)))
      } catch { if (!cancel) setScItems([]) }
    })()
    return () => { cancel = true }
  }, [formLoading, envId, token, anyVolume])

  useEffect(() => {
    if (formLoading || !envId || !token || !anyGpu) return
    let cancel = false
    void (async () => {
      const t = await detectClusterGpuType(token, envId)
      if (cancel) return
      setContainers((prev) => prev.map((c) => c.gpuEnabled ? { ...c, gpuKey: t.key, gpuLabel: t.label, gpuWarn: t.warn } : c))
    })()
    return () => { cancel = true }
  }, [formLoading, envId, token, anyGpu])

  const secretList = useMemo(() => (
    namespaceSecrets.map((s) => ({ name: s.name, keys: s.keys.filter(Boolean) })).filter((s) => s.keys.length)
  ), [namespaceSecrets])

  const patchContainer = useCallback((id, f) => {
    setContainers((prev) => prev.map((x) => (x.id === id ? f(x) : x)))
  }, [])

  const onChange = useCallback((id, partial) => {
    setContainers((prev) => prev.map((x) => (x.id === id ? { ...x, ...partial } : x)))
  }, [])

  const onExposeChange = useCallback((v) => {
    setExposeType(v)
    if (v === 'NodePort' || v === 'LoadBalancer') setSvcPorts((s) => s.length ? s : ['80'])
  }, [])

  const save = useCallback(async () => {
    if (!d || !token) return
    if (isEnvDisabled(useAppStore.getState(), envId)) {
      pushToast('This environment has been disabled by an administrator', 'err'); return
    }
    setSaving(true)
    try {
      const forBuild = withDefaultCnames(containers)
      if (nsQuota.requiresLimits || nsQuota.requiresRequests) {
        for (const c of forBuild) {
          if (!c.image?.trim()) continue
          if (nsQuota.requiresLimits && (!c.cpuLim?.trim() || !c.memLim?.trim())) {
            pushToast(`Container "${c.name || c.image}" must have CPU and memory limits — the namespace has a resource quota that requires them`, 'err')
            return
          }
          if (nsQuota.requiresRequests && (!c.cpuReq?.trim() || !c.memReq?.trim())) {
            pushToast(`Container "${c.name || c.image}" must have CPU and memory requests — the namespace has a resource quota that requires them`, 'err')
            return
          }
        }
      }

      for (const c of forBuild) {
        if (c.volumeOn) {
          const v = readVolumeDefForDeploy(c)
          if (!v) { pushToast('Complete storage volume name and mount path for any enabled volume', 'err'); return }
          if (!c.image?.trim()) { pushToast('Add an image for any container with a storage volume', 'err'); return }
        }
      }
      const pairs = forBuild.map((c) => { const spec = buildK8sContainer(c); return spec ? { id: c.id, spec } : null }).filter(Boolean)
      if (!pairs.length) { pushToast('At least one container with an image is required', 'err'); return }
      const names = pairs.map((p) => p.spec.name)
      if (new Set(names).size !== names.length) { pushToast('Each container name must be unique', 'err'); return }
      const volDefs = forBuild.map((c) => readVolumeDefForDeploy(c)).filter(Boolean)
      const specIds = pairs.map((p) => p.id)
      const validIds = new Set(specIds)
      for (const v of volDefs) {
        if (!validIds.has(v.containerId)) { pushToast('Each volume must belong to a valid container (with image)', 'err'); return }
      }
      const sp = svcPorts.map((p) => parseInt(String(p), 10)).filter((n) => n > 0)
      const deployParams = {
        appName: name,
        ns: namespace,
        instances: Math.max(0, Math.min(100, parseInt(String(instances), 10) || 0)),
        containerSpecs: pairs.map((p) => p.spec),
        containerRowIds: specIds,
        volumeDefs: volDefs,
        exposeType,
        servicePorts: sp,
        ingress: { host: ingHost.trim(), path: ingPath.trim() || '/', port: ingPort, ingressClass: ingClass.trim() },
      }

      if (isGitOps && gitOpsInfo) {
        // GitOps path: commit updated manifest — Portainer reconciles automatically
        await gitOpsUpdate({
          gitTargetId: gitOpsInfo.gitTargetId,
          branch: gitOpsInfo.gitBranch,
          gitPath: gitOpsInfo.gitPath,
          deployParams,
        })
        pushToast('Manifest committed — Portainer will apply the update automatically', 'ok')
      } else {
        // Legacy direct-apply path (for deployments not created via GitOps)
        await applyDeploymentFormUpdate(token, {
          envId: String(envId),
          ...deployParams,
        })
        pushToast('Changes applied — rolling update in progress', 'ok')
      }

      setTimeout(() => void refreshCache(false), 1500)
      await onSaved()
    } catch (e) {
      pushToast('Save failed: ' + (e?.message || String(e)), 'err')
    } finally {
      setSaving(false)
    }
  }, [d, token, envId, namespace, name, containers, instances, exposeType, svcPorts,
    ingHost, ingPath, ingPort, ingClass, onSaved, pushToast, isGitOps, gitOpsInfo])

  if (formLoading && !loadErr) {
    return <div className="loading-row"><div className="spinner" /> Loading deploy form…</div>
  }

  if (loadErr) {
    return <p style={{ color: 'var(--red)', fontSize: 13 }} role="alert">{loadErr}</p>
  }

  return (
    <div className="deploy-form" style={{ maxWidth: 900 }}>
      {isGitOps && (
        <div style={{
          marginBottom: 16, padding: '10px 14px', background: 'var(--surface2, var(--bg2))',
          border: '1px solid var(--border)', borderRadius: 6,
          fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" style={{ flexShrink: 0, color: 'var(--accent)' }}>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
          <span>
            <span style={{ color: 'var(--accent)' }}>GitOps managed</span>
            {' — '}saving will commit to <code style={{ fontFamily: 'var(--mono)' }}>{gitOpsInfo?.gitPath}</code> on branch <code style={{ fontFamily: 'var(--mono)' }}>{gitOpsInfo?.gitBranch}</code>. Portainer applies the change automatically.
          </span>
        </div>
      )}

      <div className="form-section" style={{ marginBottom: 16 }}>
        <div className="form-section-head">Scaling & identity</div>
        <div className="form-section-body">
          <DeployNameAndInstancesRow
            mode="edit" deploymentName={name}
            instances={instances} onInstancesChange={setInstances}
          />
        </div>
      </div>

      <div className="form-section" style={{ marginBottom: 16 }}>
        <div className="form-section-head">Exposure</div>
        <div className="form-section-body">
          <DeployExposureFormFields
            exposeType={exposeType} setExposeType={setExposeType}
            svcPorts={svcPorts} setSvcPorts={setSvcPorts}
            ingHost={ingHost} setIngHost={setIngHost}
            ingPath={ingPath} setIngPath={setIngPath}
            ingPort={ingPort} setIngPort={setIngPort}
            ingClass={ingClass} setIngClass={setIngClass}
            onExposeTypeChange={onExposeChange}
          />
        </div>
      </div>

      <div className="form-section" style={{ marginBottom: 8 }}>
        <div className="form-section-head">Containers</div>
        <div className="form-section-body">
          <DeployContainersFormList
            containers={containers} onChange={onChange}
            onRemove={(id) => setContainers((p) => p.filter((x) => x.id !== id))}
            onAddSidecar={() => setContainers((p) => [...p, createContainer(false)])}
            patchContainer={patchContainer}
            secretList={secretList} scItems={scItems}
            token={token} envId={String(envId)}
          />
        </div>
      </div>

      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving
            ? isGitOps ? 'Committing…' : 'Saving…'
            : isGitOps ? 'Commit changes' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
