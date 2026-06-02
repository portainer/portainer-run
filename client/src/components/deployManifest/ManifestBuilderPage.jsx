import { useCallback, useEffect, useMemo, useState } from 'react'
import { checkEnvPermissions } from '../../lib/envPermissions.js'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAppStore, visibleEnvironments, isEnvDisabled } from '../../store/useAppStore.js'
import { ROUTES } from '../../lib/routes.js'
import {
  fetchNamespaceOptions,
  fetchNamespaceQuota,
  fetchSecretsInNamespace,
  fetchStorageClasses,
  fetchConfigMapsInNamespace,
  fetchImagePullSecrets,
  detectClusterGpuType,
} from '../../lib/deployK8s.js'
import { defaultManifestBuilderState } from '../../lib/manifestBuilderModel.js'
import { gitOpsDeployManifestBuilder } from '../../lib/gitTargets.js'
import { listGitTargets } from '../../lib/gitTargets.js'
import { manualRefresh, schedulePostDeployRefreshes } from '../../services/refreshDeployments.js'
import { GitOpsStep } from '../deploy/GitOpsStep.jsx'
import { MBStep1Target } from './sections/MBStep1Target.jsx'
import { MBStep2App } from './sections/MBStep2App.jsx'

const STEPS = [
  { num: 1, label: 'Target' },
  { num: 2, label: 'Application' },
  { num: 3, label: 'Deploy' },
]

function Stepper({ current }) {
  return (
    <div className="mb-stepper">
      {STEPS.map((s, i) => {
        const state = s.num < current ? 'done' : s.num === current ? 'active' : 'idle'
        return (
          <div key={s.num} style={{ display: 'flex', alignItems: 'center' }}>
            <div className={`mb-step mb-step--${state}`}>
              <div className="mb-step-num">
                {state === 'done' ? '✓' : s.num}
              </div>
              <span className="mb-step-label">{s.label}</span>
            </div>
            {i < STEPS.length - 1 && <div className="mb-step-sep" />}
          </div>
        )
      })}
    </div>
  )
}

export function ManifestBuilderPage() {
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const pushToast = useAppStore((s) => s.pushToast)
  const envPermissions = useAppStore((s) => s.envPermissions)
  const vis = useMemo(() => visibleEnvironments({ environments, disabledEnvs }), [environments, disabledEnvs])

  const location = useLocation()
  const [noGitTargets, setNoGitTargets] = useState(false)
  useEffect(() => {
    listGitTargets().then((r) => setNoGitTargets(!r || r.length === 0)).catch(() => {})
  }, [])

    const [step, setStep] = useState(1)
  const [form, setForm] = useState(defaultManifestBuilderState)
  const [deploying, setDeploying] = useState(false)
  const [catalogueWarnings, setCatalogueWarnings] = useState([])

  // Pre-populate from catalogue Customise (type: kubernetes)
  useEffect(() => {
    const { cataloguePreload, catalogueWarnings: w, wizardEnvId, wizardNs } = location.state || {}
    if (!cataloguePreload) return
    setForm((f) => ({
      ...f,
      ...cataloguePreload,
      envId: wizardEnvId || f.envId,
      namespace: wizardNs || f.namespace,
      manualNs: Boolean(wizardNs),
      manualNsValue: wizardNs || '',
    }))
    setCatalogueWarnings(w || [])
    // Jump to step 2 since env/ns already selected
    if (wizardEnvId && wizardNs) setStep(2)
    // Clear state so refresh doesn't re-apply
    window.history.replaceState({}, '')
  }, [])

  // Namespace fetch state
  const [nsList, setNsList] = useState([])
  const [nsLoading, setNsLoading] = useState(false)
  const [nsStatus, setNsStatus] = useState({ text: '', tone: 'dim' })

  // Namespace-derived data
  const [nsQuota, setNsQuota] = useState({ requiresLimits: false, requiresRequests: false })
  const [secretList, setSecretList] = useState([])
  const [configMapList, setConfigMapList] = useState([])
  const [pullSecrets, setPullSecrets] = useState([])
  const [storageClasses, setStorageClasses] = useState([])
  const [gpuInfo, setGpuInfo] = useState({ key: 'nvidia.com/gpu', label: '', warn: undefined })
  const [gpuAvailable, setGpuAvailable] = useState(false)

  const patch = useCallback((partial) => setForm((f) => ({ ...f, ...partial })), [])
  const resolvedNs = form.manualNs ? form.manualNsValue.trim() : form.namespace

  // Load namespaces when environment changes
  useEffect(() => {
    if (!form.envId || !token) {
      setNsList([]); setNsStatus({ text: '', tone: 'dim' }); return
    }
    setNsLoading(true)
    void (async () => {
      try {
        const r = await fetchNamespaceOptions(token, form.envId)
        if (r.ok && r.manual) {
          patch({ manualNs: true, namespace: '' })
          setNsStatus({ text: r.message || 'Enter namespace manually', tone: 'amber' })
        } else if (r.ok) {
          setNsList(r.namespaces)
          patch({ manualNs: false, namespace: r.namespaces[0] || '' })
          setNsStatus({ text: r.message || '', tone: 'green' })
        } else {
          patch({ manualNs: true, namespace: '' })
          setNsStatus({ text: r.error || 'Could not load namespaces', tone: 'red' })
        }
      } catch (e) {
        patch({ manualNs: true })
        setNsStatus({ text: e?.message || 'Error', tone: 'red' })
      } finally {
        setNsLoading(false)
      }
    })()
  }, [form.envId, token, patch])

  // Load namespace-derived data when ns changes
  useEffect(() => {
    if (!form.envId || !token || !resolvedNs) return
    let cancel = false
    void Promise.all([
      fetchNamespaceQuota(token, form.envId, resolvedNs).then((q) => { if (!cancel) setNsQuota(q) }),
      fetchSecretsInNamespace(token, form.envId, resolvedNs).then((s) => {
        if (cancel) return
        setSecretList(s.map((x) => ({ name: x.metadata?.name || x.name, keys: Object.keys(x.data || {}) })))
      }),
      fetchConfigMapsInNamespace(token, form.envId, resolvedNs).then((c) => { if (!cancel) setConfigMapList(c) }),
      fetchImagePullSecrets(token, form.envId, resolvedNs).then((p) => { if (!cancel) setPullSecrets(p) }),
      fetchStorageClasses(token, form.envId).then((sc) => {
        if (cancel) return
        setStorageClasses((sc || []).map((c) => c.metadata.name))
        const def = (sc || []).find((c) => c.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true')
        if (def) patch({ defaultStorageClass: def.metadata.name })
      }),
      detectClusterGpuType(token, form.envId).then((g) => {
        if (cancel) return
        setGpuInfo(g)
        setGpuAvailable(Boolean(g.key && !g.warn))
      }),
    ])
    return () => { cancel = true }
  }, [form.envId, token, resolvedNs, patch])

  function validateStep1() {
    if (!form.envId) { pushToast('Select a deployment target', 'err'); return false }
    if (isEnvDisabled({ disabledEnvs }, form.envId)) { pushToast('This environment has been disabled', 'err'); return false }
    if (!resolvedNs) { pushToast('Select or enter a namespace', 'err'); return false }
    return true
  }

  function validateStep2() {
    const name = form.appName.trim()
    if (!name) { pushToast('Application name is required', 'err'); return false }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { pushToast('Name must be lowercase alphanumeric and hyphens', 'err'); return false }
    if (!form.image.trim()) { pushToast('Container image is required', 'err'); return false }
    if (nsQuota.requiresLimits && (!form.cpuLim?.trim() || !form.memLim?.trim())) {
      pushToast('CPU and memory limits are required — namespace has a resource quota', 'err'); return false
    }
    if (nsQuota.requiresRequests && (!form.cpuReq?.trim() || !form.memReq?.trim())) {
      pushToast('CPU and memory requests are required — namespace has a resource quota', 'err'); return false
    }
    return true
  }

  function onNext() {
    if (step === 1 && !validateStep1()) return
    if (step === 2 && !validateStep2()) return
    setStep((s) => s + 1)
  }

  function onBack() {
    setStep((s) => Math.max(1, s - 1))
  }

  async function onGitOpsConfirm({ gitTargetId, branch, pathPrefix, pollInterval }) {
    if (deploying) return
    setDeploying(true)
    try {
      await gitOpsDeployManifestBuilder({
        gitTargetId,
        branch,
        pathPrefix,
        pollInterval,
        envId: form.envId,
        manifestBuilderParams: { ...form, namespace: resolvedNs },
      })
      pushToast(`"${form.appName}" committed to Git and GitOps stack created`, 'ok')
      void manualRefresh()
      schedulePostDeployRefreshes()
      navigate(ROUTES.services)
    } catch (e) {
      pushToast('Deploy failed: ' + (e?.message || String(e)), 'err')
    } finally {
      setDeploying(false)
    }
  }

  const patchEnvPermissions = useAppStore((s) => s.patchEnvPermissions)
  const deployPerms = (form.envId && resolvedNs) ? (envPermissions[`${form.envId}:${resolvedNs}`] || { canDeploy: true, canCreatePvc: true }) : { canDeploy: true, canCreatePvc: true }
  const hasVolumes = form.volumes && form.volumes.length > 0
  const canProceed = deployPerms.canDeploy && (!hasVolumes || deployPerms.canCreatePvc)

  // Fire permission check when both env and namespace are selected
  useEffect(() => {
    if (!form.envId || !resolvedNs || !token) return
    const key = `${form.envId}:${resolvedNs}`
    if (envPermissions[key] !== undefined) return
    void checkEnvPermissions(token, form.envId, resolvedNs)
      .then((p) => patchEnvPermissions(form.envId, resolvedNs, p))
  }, [form.envId, resolvedNs])

  const nsStatusColor = { amber: 'var(--amber)', green: 'var(--green)', red: 'var(--red)', dim: 'var(--text-dim)' }[nsStatus.tone] || 'var(--text-dim)'

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Manifest Builder</div>
          <div className="page-sub">
            Deploy any Kubernetes workload type using a guided form. Output is committed to Git and deployed via Portainer GitOps.
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

        <Stepper current={step} />

        {!deployPerms.canDeploy && form.envId && (
          <div style={{
            marginBottom: 16, padding: '14px 18px',
            background: 'rgba(239,68,68,0.08)', border: '1px solid var(--red)',
            borderRadius: 8, fontSize: 13, color: 'var(--red)',
            fontFamily: 'var(--mono)', display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              width="16" height="16" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            You do not have permission to deploy workloads in the selected environment. Select a different environment or contact your platform administrator.
          </div>
        )}
        {hasVolumes && !deployPerms.canCreatePvc && form.envId && resolvedNs && (
          <div style={{
            marginBottom: 16, padding: '14px 18px',
            background: 'rgba(239,68,68,0.08)', border: '1px solid var(--red)',
            borderRadius: 8, fontSize: 13, color: 'var(--red)',
            fontFamily: 'var(--mono)', display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              width="16" height="16" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            You do not have permission to create PersistentVolumeClaims in namespace &quot;{resolvedNs}&quot;. Remove volumes or select a different namespace.
          </div>
        )}

        {step === 1 && (
          <MBStep1Target
            vis={vis}
            form={form}
            patch={patch}
            nsList={nsList}
            nsLoading={nsLoading}
            nsStatus={nsStatus}
            nsStatusColor={nsStatusColor}
            onNext={canProceed ? onNext : () => {}}
            onCancel={() => navigate(ROUTES.services)}
            nextDisabled={!canProceed}
          />
        )}

        {step === 2 && (
          <MBStep2App
            form={form}
            patch={patch}
            catalogueWarnings={catalogueWarnings}
            secretList={secretList}
            configMapList={configMapList}
            pullSecrets={pullSecrets}
            storageClasses={storageClasses}
            gpuInfo={gpuInfo}
            gpuAvailable={gpuAvailable}
            nsQuota={nsQuota}
            onNext={onNext}
            onBack={onBack}
          />
        )}

        {step === 3 && (
          <GitOpsStep
            appName={form.appName}
            ns={resolvedNs}
            envId={form.envId}
            manifestBuilderParams={{ ...form, namespace: resolvedNs }}
            onConfirm={onGitOpsConfirm}
            onBack={onBack}
            deploying={deploying}
          />
        )}


      </div>
    </div>
  )
}
