import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAppStore, visibleEnvironments, isEnvDisabled } from '../store/useAppStore.js'
import { mapDeployConfigToFormValues, parseKnativeManifest } from '../lib/catalogueTemplate.js'
import { ROUTES } from '../lib/routes.js'
import { manualRefresh, schedulePostDeployRefreshes } from '../services/refreshDeployments.js'
import {
  buildK8sContainer,
  detectClusterGpuType,
  fetchNamespaceOptions,
  fetchNamespaceQuota,
  fetchSecretsInNamespace,
  fetchStorageClasses,
  readVolumeDefForDeploy,
} from '../lib/deployK8s.js'
import { fetchTemplatesJson } from '../lib/fetchTemplatesJson.js'
import { inflightDedupe } from '../lib/inflightDedupe.js'
import { createContainer, withDefaultCnames } from '../lib/deployFormModel.js'
import { gitOpsDeploy } from '../lib/gitTargets.js'
import { listGitTargets } from '../lib/gitTargets.js'
import { checkEnvPermissions } from '../lib/envPermissions.js'
import {
  DeployContainersFormList,
  DeployExposureFormFields,
  DeployNameAndInstancesRow,
} from './deploy/DeployFormSections.jsx'
import { GitOpsStep } from './deploy/GitOpsStep.jsx'

const SD_STEPS = [
  { num: 1, label: 'Target' },
  { num: 2, label: 'Application' },
  { num: 3, label: 'Deploy' },
]

function Stepper({ current }) {
  return (
    <div className="mb-stepper">
      {SD_STEPS.map((s, i) => {
        const state = s.num < current ? 'done' : s.num === current ? 'active' : 'idle'
        return (
          <div key={s.num} style={{ display: 'flex', alignItems: 'center' }}>
            <div className={`mb-step mb-step--${state}`}>
              <div className="mb-step-num">{state === 'done' ? '✓' : s.num}</div>
              <span className="mb-step-label">{s.label}</span>
            </div>
            {i < SD_STEPS.length - 1 && <div className="mb-step-sep" />}
          </div>
        )
      })}
    </div>
  )
}

export function DeployPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [noGitTargets, setNoGitTargets] = useState(false)
  useEffect(() => {
    listGitTargets().then((r) => setNoGitTargets(!r || r.length === 0)).catch(() => {})
  }, [])

    const [searchParams] = useSearchParams()
  const token = useAppStore((s) => s.token)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const pushToast = useAppStore((s) => s.pushToast)
  const envPermissions = useAppStore((s) => s.envPermissions)
  const cataloguePrefillDone = useRef(false)
  const lastAssistantDeployKey = useRef('')

  const [serviceName, setServiceName] = useState('')
  const [envId, setEnvId] = useState('')
  const [namespace, setNamespace] = useState('')
  const [manualNs, setManualNs] = useState(false)
  const [manualNsValue, setManualNsValue] = useState('')
  const [nsStatus, setNsStatus] = useState({ text: '', tone: 'dim' })
  const [nsLoading, setNsLoading] = useState(false)
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
  const [nsList, setNsList] = useState([])

  const [nsQuota, setNsQuota] = useState({ requiresLimits: false, requiresRequests: false })

  const [step, setStep] = useState(1)
  const [deploying, setDeploying] = useState(false)
  // Staged deploy params — built on form validation, passed to GitOps step
  const [stagedParams, setStagedParams] = useState(null)

  const templateQueryId = searchParams.get('template')
  const catalogueFromNav = location.state?.catalogueTemplate

  useEffect(() => {
    const deployCfg = location.state?.deployConfigFromAssistant
    if (!deployCfg) { lastAssistantDeployKey.current = ''; return }
    const key = JSON.stringify(deployCfg)
    if (key === lastAssistantDeployKey.current) return
    lastAssistantDeployKey.current = key
    try {
      const v = mapDeployConfigToFormValues(deployCfg)
      setServiceName(v.serviceName)
      setInstances(v.instances)
      setExposeType(v.exposeType)
      setSvcPorts(v.svcPorts)
      setIngHost(v.ingHost)
      setIngPath(v.ingPath)
      setIngPort(v.ingPort)
      setIngClass(v.ingClass)
      if (v.containers?.length) setContainers(v.containers)
      else setContainers([createContainer(true)])
      pushToast('Deploy form populated from Assistant — review and select a target environment if needed', 'info')
    } catch (e) {
      pushToast('Could not apply deploy config: ' + (e?.message || 'Unknown'), 'err')
    }
    navigate({ pathname: ROUTES.deploy, search: '' }, { replace: true, state: {} })
  }, [location.state, navigate, pushToast])

  useEffect(() => {
    if (cataloguePrefillDone.current) return

    function applyFromCatalogueEntry(entry) {
      if (!entry?.manifest) {
        pushToast('Template has no manifest', 'err')
        cataloguePrefillDone.current = true
        navigate({ pathname: ROUTES.deploy, search: '' }, { replace: true, state: {} })
        return
      }
      const bd = (useAppStore.getState().baseDomain || '').trim()
      const cfg = parseKnativeManifest(entry.manifest, { baseDomain: bd })
      const v = mapDeployConfigToFormValues(cfg)
      setServiceName(v.serviceName)
      setInstances(v.instances)
      setExposeType(v.exposeType)
      setSvcPorts(v.svcPorts)
      setIngHost(v.ingHost)
      setIngPath(v.ingPath)
      setIngPort(v.ingPort)
      setIngClass(v.ingClass)
      if (v.containers?.length) setContainers(v.containers)
      const wizardEnvId = location.state?.wizardEnvId
      const wizardNs = location.state?.wizardNs
      if (wizardEnvId) setEnvId(String(wizardEnvId))
      if (wizardNs) { setManualNsValue(wizardNs); setManualNs(true) }
      cataloguePrefillDone.current = true
      pushToast(
        wizardEnvId
          ? `Loaded template "${entry.name || entry.id}" — environment and namespace pre-selected`
          : `Loaded template "${entry.name || entry.id}" — pick a deployment target and namespace`,
        'info',
      )
      navigate({ pathname: ROUTES.deploy, search: '' }, { replace: true, state: {} })
    }

    if (catalogueFromNav) { applyFromCatalogueEntry(catalogueFromNav); return }
    if (!templateQueryId) return

    let cancel = false
    void (async () => {
      try {
        const data = await inflightDedupe('deploy:templates-json', () => fetchTemplatesJson())
        if (cancel) return
        const t = (data.templates || []).find((x) => x.id === templateQueryId)
        if (!t) {
          pushToast('Template not found: ' + templateQueryId, 'err')
          cataloguePrefillDone.current = true
          navigate({ pathname: ROUTES.deploy, search: '' }, { replace: true })
          return
        }
        applyFromCatalogueEntry(t)
      } catch (e) {
        if (cancel) return
        pushToast((e?.message) || 'Could not load templates', 'err')
        cataloguePrefillDone.current = true
        navigate({ pathname: ROUTES.deploy, search: '' }, { replace: true })
      }
    })()
    return () => { cancel = true }
  }, [catalogueFromNav, templateQueryId, navigate, pushToast])

  const vis = useMemo(() => visibleEnvironments({ environments, disabledEnvs }), [environments, disabledEnvs])
  const resolvedNs = manualNs ? manualNsValue.trim() : namespace
  const patchEnvPermissions = useAppStore((s) => s.patchEnvPermissions)
  const deployPerms = (envId && resolvedNs) ? (envPermissions[`${envId}:${resolvedNs}`] || { canDeploy: true }) : { canDeploy: true }

  // Fire permission check when both env and namespace are selected
  useEffect(() => {
    if (!envId || !resolvedNs || !token) return
    const key = `${envId}:${resolvedNs}`
    if (envPermissions[key] !== undefined) return
    void checkEnvPermissions(token, envId, resolvedNs)
      .then((p) => patchEnvPermissions(envId, resolvedNs, p))
  }, [envId, resolvedNs])

  const secretList = useMemo(() => (
    namespaceSecrets.map((s) => ({ name: s.name, keys: s.keys.filter(Boolean) })).filter((s) => s.keys.length)
  ), [namespaceSecrets])

  const patchContainer = useCallback((id, f) => {
    setContainers((prev) => prev.map((x) => (x.id === id ? f(x) : x)))
  }, [])

  const onChange = useCallback((id, partial) => {
    setContainers((prev) => prev.map((x) => (x.id === id ? { ...x, ...partial } : x)))
  }, [])

  useEffect(() => {
    if (!envId || !token || !resolvedNs) { setNsQuota({ requiresLimits: false, requiresRequests: false }); return }
    void fetchNamespaceQuota(token, envId, resolvedNs).then(setNsQuota)
  }, [envId, token, resolvedNs])

  useEffect(() => {
    if (!envId || !token || !resolvedNs) { setNamespaceSecrets([]); return }
    let cancel = false
    void (async () => {
      const items = await fetchSecretsInNamespace(token, envId, resolvedNs)
      if (cancel) return
      setNamespaceSecrets(items.map((s) => ({ name: s.metadata.name, keys: Object.keys(s.data || {}) })))
    })()
    return () => { cancel = true }
  }, [envId, token, resolvedNs])

  const anyVolume = useMemo(() => containers.some((c) => c.volumeOn), [containers])
  const anyGpu = useMemo(() => containers.some((c) => c.gpuEnabled), [containers])

  useEffect(() => {
    if (!envId || !token || !anyVolume) { if (!anyVolume) setScItems([]); return }
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
  }, [envId, token, anyVolume])

  useEffect(() => {
    if (!envId || !token || !anyGpu) return
    let cancel = false
    void (async () => {
      const t = await detectClusterGpuType(token, envId)
      if (cancel) return
      setContainers((prev) => prev.map((c) => c.gpuEnabled ? { ...c, gpuKey: t.key, gpuLabel: t.label, gpuWarn: t.warn } : c))
    })()
    return () => { cancel = true }
  }, [envId, token, anyGpu])

  const loadNs = useCallback(async (eid) => {
    if (!eid || !token) { setNamespace(''); setNsList([]); setManualNs(false); setNsStatus({ text: '', tone: 'dim' }); return }
    setNsLoading(true)
    setNsStatus({ text: 'Loading…', tone: 'dim' })
    try {
      const r = await fetchNamespaceOptions(token, eid)
      if (r.ok && r.manual) {
        setNsList([]); setManualNs(true); setNamespace('')
        setNsStatus({ text: r.message || '', tone: 'amber' })
      } else if (r.ok) {
        setNsList(r.namespaces); setManualNs(false)
        setNamespace(r.namespaces[0] || '')
        setNsStatus({ text: r.message || '', tone: 'green' })
      } else {
        setNsList([]); setManualNs(true); setNamespace('')
        setNsStatus({ text: r.error || 'Failed', tone: 'red' })
      }
    } catch (e) {
      setNsList([]); setManualNs(true)
      setNsStatus({ text: e?.message || 'Error', tone: 'red' })
    } finally {
      setNsLoading(false)
    }
  }, [token])

  useEffect(() => { if (envId) void loadNs(envId) }, [envId, loadNs])

  const resetForm = useCallback(() => {
    setServiceName(''); setNamespace(''); setNsList([]); setManualNs(false); setManualNsValue('')
    setNsStatus({ text: '', tone: 'dim' }); setInstances(1); setExposeType('none')
    setSvcPorts(['80']); setIngHost(''); setIngPath('/'); setIngPort(80); setIngClass('')
    setContainers([createContainer(true)]); setStep(1); setStagedParams(null)
  }, [])

  /** Validate form and build staged params — advances to GitOps step */
  function onNext() {
    const name = serviceName.trim()
    if (!name) { pushToast('Service name is required', 'err'); return }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { pushToast('Name must be lowercase alphanumeric and hyphens', 'err'); return }
    if (!envId) { pushToast('Select a deployment target', 'err'); return }
    if (isEnvDisabled(useAppStore.getState(), envId)) { pushToast('This environment has been disabled by an administrator', 'err'); return }
    if (!resolvedNs) { pushToast('Select or enter a namespace', 'err'); return }

    // Validate resource limits if namespace quota requires them
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
    const servicePorts = svcPorts.map((p) => parseInt(String(p), 10)).filter((n) => n > 0)

    setStagedParams({
      appName: name,
      ns: resolvedNs,
      envId,
      instances: Math.max(0, Math.min(100, parseInt(String(instances), 10) || 1)),
      containerSpecs: pairs.map((p) => p.spec),
      containerRowIds: specIds,
      volumeDefs: volDefs,
      exposeType,
      servicePorts,
      ingress: { host: ingHost.trim(), path: ingPath.trim() || '/', port: ingPort, ingressClass: ingClass.trim() },
    })
    setStep(3)
  }

  /** Called by GitOpsStep when the user confirms git target + branch */
  async function onGitOpsConfirm({ gitTargetId, branch, pathPrefix, pollInterval }) {
    if (!stagedParams) return
    setDeploying(true)
    try {
      const { appName, ns, envId: eid, ...deployParams } = stagedParams
      await gitOpsDeploy({
        gitTargetId,
        branch,
        pathPrefix,
        pollInterval,
        envId: eid,
        deployParams: { appName, ns, ...deployParams },
      })
      const cCount = stagedParams.containerSpecs.length
      const exposeLabel = exposeType === 'none' ? 'no external exposure'
        : exposeType === 'Ingress' ? 'Ingress configured'
        : `${exposeType} service created`
      pushToast(`"${appName}" committed to Git and GitOps stack created — ${cCount} container(s), ${exposeLabel}`, 'ok')
      resetForm()
      void manualRefresh()
      schedulePostDeployRefreshes()
      navigate(ROUTES.services)
    } catch (e) {
      pushToast((e?.message) || 'Deploy failed', 'err')
    } finally {
      setDeploying(false)
    }
  }

  const nsStatusColor = nsStatus.tone === 'amber' ? 'var(--amber)'
    : nsStatus.tone === 'green' ? 'var(--green)'
    : nsStatus.tone === 'red' ? 'var(--red)' : 'var(--text-dim)'

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Simple Deploy</div>
          <div className="page-sub">
            Deploy a containerised application as a single service. All containers share a pod and a single network identity. For more complex workloads, use <Link to={ROUTES.deployManifest} style={{ color: 'var(--accent)' }}>Manifest Builder</Link>.
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

        <Stepper current={step} />

        {/* ── Step 1: Target ── */}
        {step === 1 && (
          <div className="form-section">
            <div className="form-section-head">Step 1 — Target</div>
            <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {!deployPerms.canDeploy && envId && (
                <div style={{
                  padding: '12px 14px', background: 'rgba(239,68,68,0.08)',
                  border: '1px solid var(--red)', borderRadius: 8,
                  fontSize: 13, color: 'var(--red)', fontFamily: 'var(--mono)',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    width="16" height="16" style={{ flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  You do not have permission to deploy workloads in the selected environment.
                </div>
              )}
              <div className="frow">
                <div className="field">
                  <label>Deployment target</label>
                  <select value={envId} onChange={(e) => { setEnvId(e.target.value); setNamespace(''); setNsList([]); setNsStatus({ text: '', tone: 'dim' }) }}>
                    <option value="">— Select —</option>
                    {vis.map((e) => <option key={e.Id} value={e.Id}>{e.Name}</option>)}
                  </select>
                  <div className="hint">Portainer environment to deploy into</div>
                </div>
                <div className="field">
                  <label>Namespace</label>
                  {!manualNs && (
                    <select value={namespace} onChange={(e) => setNamespace(e.target.value)} disabled={!envId || nsLoading}>
                      <option value="">{!envId ? 'Select target first...' : nsLoading ? 'Loading namespaces...' : '— Select —'}</option>
                      {nsList.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  )}
                  {manualNs && (
                    <input type="text" value={manualNsValue} onChange={(e) => setManualNsValue(e.target.value)} placeholder="my-namespace" />
                  )}
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: nsStatusColor, marginTop: 4 }}>{nsStatus.text}</div>
                  <div className="hint">Namespace must already exist in the target</div>
                </div>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => { resetForm(); navigate(ROUTES.services) }}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={() => {
                  if (!envId) { pushToast('Select a deployment target', 'err'); return }
                  if (!resolvedNs) { pushToast('Select or enter a namespace', 'err'); return }
                  if (!deployPerms.canDeploy) { pushToast('No deploy permission in this environment', 'err'); return }
                  setStep(2)
                }}
                  disabled={!envId || !deployPerms.canDeploy}>
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Application ── */}
        {step === 2 && (
          <>
            <div className="form-section">
              <div className="form-section-head">Service</div>
              <div className="form-section-body">
                <DeployNameAndInstancesRow
                  mode="create"
                  serviceName={serviceName}
                  onServiceNameChange={setServiceName}
                  instances={instances}
                  onInstancesChange={setInstances}
                />
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-head">Exposure</div>
              <div className="form-section-body">
                <DeployExposureFormFields
                  exposeType={exposeType} setExposeType={setExposeType}
                  svcPorts={svcPorts} setSvcPorts={setSvcPorts}
                  ingHost={ingHost} setIngHost={setIngHost}
                  ingPath={ingPath} setIngPath={setIngPath}
                  ingPort={ingPort} setIngPort={setIngPort}
                  ingClass={ingClass} setIngClass={setIngClass}
                  onExposeTypeChange={(v) => { setExposeType(v); if (v === 'NodePort' || v === 'LoadBalancer') setSvcPorts((s) => s.length ? s : ['80']) }}
                />
              </div>
            </div>

            <div className="form-section">
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
              <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>← Back</button>
              <button type="button" className="btn btn-primary" onClick={onNext}>Next: Git Target →</button>
            </div>
          </>
        )}

        {/* ── Step 3: Deploy (GitOps) ── */}
        {step === 3 && stagedParams && (
          <GitOpsStep
            appName={stagedParams.appName}
            ns={stagedParams.ns}
            envId={stagedParams.envId}
            deployParams={stagedParams}
            onConfirm={onGitOpsConfirm}
            onBack={() => setStep(2)}
            deploying={deploying}
          />
        )}
      </div>
    </div>
  )
}
