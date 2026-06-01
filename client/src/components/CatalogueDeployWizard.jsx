import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore, visibleEnvironments, isEnvDisabled } from '../store/useAppStore.js'
import { ROUTES } from '../lib/routes.js'
import { parseKnativeManifest, CATALOGUE_CATEGORY_COLORS, CATALOGUE_CATEGORY_LABELS, CATALOGUE_TYPE_LABELS, CATALOGUE_TYPE_COLORS, getCatalogueItemType } from '../lib/catalogueTemplate.js'
import { deployHelm } from '../lib/helmDeploy.js'
import { checkEnvPermissions } from '../lib/envPermissions.js'
import { yamlToManifestBuilder } from '../lib/yamlToManifestBuilder.js'
import { HelmValuesEditor } from './catalogue/HelmValuesEditor.jsx'
import { fetchNamespaceOptions } from '../lib/deployK8s.js'
import { gitOpsDeploy } from '../lib/gitTargets.js'
import { manualRefresh, schedulePostDeployRefreshes } from '../services/refreshDeployments.js'
import { GitOpsStep } from './deploy/GitOpsStep.jsx'

export function CatalogueDeployWizard({ template, onClose }) {
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const baseDomain = useAppStore((s) => s.baseDomain)
  const pushToast = useAppStore((s) => s.pushToast)
  const envPermissions = useAppStore((s) => s.envPermissions)
  const vis = visibleEnvironments({ environments, disabledEnvs })

  // step 1: env/ns, step 2: confirm summary, step 3: git target
  const [step, setStep] = useState(1)
  const [envId, setEnvId] = useState('')
  const [nsList, setNsList] = useState([])
  const [namespace, setNamespace] = useState('')
  const [manualNs, setManualNs] = useState(false)
  const [manualNsValue, setManualNsValue] = useState('')
  const [nsStatus, setNsStatus] = useState({ text: '', tone: 'dim' })
  const [nsLoading, setNsLoading] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const itemType = getCatalogueItemType(template)
  const patchEnvPermissions = useAppStore((s) => s.patchEnvPermissions)

  const [helmValues, setHelmValues] = useState('')
  const [helmReleaseName, setHelmReleaseName] = useState('')

  const resolvedNs = manualNs ? manualNsValue.trim() : namespace

  const deployPerms = (envId && resolvedNs) ? (envPermissions[`${envId}:${resolvedNs}`] || { canDeploy: true }) : { canDeploy: true }

  // Fire permission check when both env and namespace are selected
  useEffect(() => {
    if (!envId || !resolvedNs || !token) return
    const key = `${envId}:${resolvedNs}`
    if (envPermissions[key] !== undefined) return
    void checkEnvPermissions(token, envId, resolvedNs)
      .then((p) => patchEnvPermissions(envId, resolvedNs, p))
  }, [envId, resolvedNs])

  const resetNs = useCallback(() => {
    setNsList([]); setNamespace(''); setManualNs(false); setManualNsValue('')
    setNsStatus({ text: '', tone: 'dim' })
  }, [])

  useEffect(() => {
    if (!envId || !token) { resetNs(); return }
    let cancelled = false
    setNsLoading(true); resetNs()
    setNsStatus({ text: 'Loading…', tone: 'dim' })
    ;(async () => {
      try {
        const r = await fetchNamespaceOptions(token, envId)
        if (cancelled) return
        if (r.ok && r.manual) {
          setManualNs(true); setNsStatus({ text: r.message || 'Enter namespace manually', tone: 'amber' })
        } else if (r.ok) {
          setNsList(r.namespaces)
          setNamespace(r.namespaces.find((n) => n === 'default') || r.namespaces[0] || '')
          setNsStatus({ text: r.message || '', tone: 'green' })
        } else {
          setManualNs(true); setNsStatus({ text: r.error || 'Could not load namespaces', tone: 'red' })
        }
      } catch (e) {
        if (cancelled) return
        setManualNs(true); setNsStatus({ text: e?.message || 'Error loading namespaces', tone: 'red' })
      } finally {
        if (!cancelled) setNsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [envId, token, resetNs])

  useEffect(() => {
    setStep(1); setEnvId(''); resetNs(); setNsLoading(false)
    if (template?.helm) {
      setHelmValues(template.helm.defaultValues || '')
      setHelmReleaseName(template.helm.chart || '')
    }
  }, [template?.id, resetNs])

  if (!template) return null

  const cfg = parseKnativeManifest(template.manifest || {}, { baseDomain })
  const color = CATALOGUE_CATEGORY_COLORS[template.category] || 'var(--text-dim)'
  const catLabel = CATALOGUE_CATEGORY_LABELS[template.category] || template.category || ''
  const env = environments.find((e) => String(e.Id) === String(envId))

  const containerSummary = (template.manifest?.spec?.template?.spec?.containers || [])
    .map((c) => c.image || c.name).join(', ') || '—'

  let exposureSummary = 'None'
  if (cfg.exposure && cfg.exposure.type !== 'none') {
    if (cfg.exposure.type === 'Ingress' && cfg.exposure.host) exposureSummary = 'Ingress → ' + cfg.exposure.host
    else if (cfg.exposure.ports?.length) exposureSummary = cfg.exposure.type + ' port ' + cfg.exposure.ports.join(', ')
    else if (cfg.exposure.port) exposureSummary = cfg.exposure.type + ' port ' + cfg.exposure.port
    else exposureSummary = cfg.exposure.type
  }

  const gpuContainers = cfg.containers.filter((c) => c.gpuKey && c.gpuCount > 0)
  const gpuSummary = gpuContainers.length
    ? gpuContainers.map((c) => c.gpuCount + '× ' + (c.gpuKey.split('/')[1] || c.gpuKey)).join(', ')
    : null

  function onNext() {
    if (!envId) { pushToast('Select an environment', 'err'); return }
    if (isEnvDisabled({ disabledEnvs }, envId)) { pushToast('This environment has been disabled by an administrator', 'err'); return }
    if (!resolvedNs) { pushToast('Select or enter a namespace', 'err'); return }
    setStep(2)
  }

  function onCustomize() {
    onClose()
    if (itemType === 'kubernetes') {
      // Parse YAML into MB form state and navigate to Manifest Builder
      const { state, warnings } = yamlToManifestBuilder(template.manifest || '')
      navigate(ROUTES.deployManifest, {
        state: {
          cataloguePreload: state,
          catalogueWarnings: warnings,
          wizardEnvId: envId,
          wizardNs: resolvedNs,
        },
      })
    } else {
      navigate(ROUTES.deploy, { state: { catalogueTemplate: template, wizardEnvId: envId, wizardNs: resolvedNs } })
    }
  }

  /** Build deploy params from parsed catalogue config */
  function buildDeployParams() {
    const containerRowIds = cfg.containers.map((_, i) => 'wz-ct-' + i)
    const containerSpecs = cfg.containers.map((ct) => {
      const spec = { name: ct.name, image: ct.image, imagePullPolicy: 'Always' }
      const res = {
        requests: { cpu: ct.cpuReq, memory: ct.memReq },
        limits: { cpu: ct.cpuLim, memory: ct.memLim },
      }
      if (ct.gpuKey && ct.gpuCount > 0) { res.limits[ct.gpuKey] = String(ct.gpuCount); res.requests[ct.gpuKey] = String(ct.gpuCount) }
      spec.resources = res
      if (ct.env?.length) spec.env = ct.env
      if (ct.storage) spec.volumeMounts = [{ name: ct.storage.name, mountPath: ct.storage.mountPath }]
      return spec
    })
    const volumeDefs = cfg.containers.filter((ct) => ct.storage).map((ct) => ({
      containerId: containerRowIds[cfg.containers.indexOf(ct)],
      name: ct.storage.name, size: ct.storage.size || '1Gi', mountPath: ct.storage.mountPath,
    }))
    const exposeType = cfg.exposure?.type === 'Ingress' ? 'Ingress'
      : cfg.exposure?.type === 'LoadBalancer' ? 'LoadBalancer'
      : cfg.exposure?.type === 'NodePort' ? 'NodePort' : 'none'
    const servicePorts = cfg.exposure?.ports?.length ? cfg.exposure.ports
      : cfg.exposure?.port ? [cfg.exposure.port] : [80]
    return {
      appName: cfg.name,
      ns: resolvedNs,
      instances: cfg.instances || 1,
      containerSpecs,
      containerRowIds,
      volumeDefs,
      exposeType,
      servicePorts,
      ingress: { host: cfg.exposure?.host || '', path: '/', port: cfg.exposure?.port || servicePorts[0] || 80, ingressClass: '' },
    }
  }

  async function onGitOpsConfirm({ gitTargetId, branch, pathPrefix, pollInterval }) {
    setDeploying(true)
    try {
      if (itemType === 'helm') {
        await deployHelm({
          envId,
          namespace: resolvedNs,
          releaseName: helmReleaseName || template?.helm?.chart,
          chart: template?.helm?.chart,
          repo: template?.helm?.repo,
          version: template?.helm?.version,
          values: helmValues,
        })
        pushToast(`"${helmReleaseName || template?.helm?.chart}" Helm release deployed to ${resolvedNs}`, 'ok')
      } else {
        const deployParams = buildDeployParams()
        await gitOpsDeploy({ gitTargetId, branch, pathPrefix, pollInterval, envId, deployParams })
        pushToast(`"${cfg.name}" committed to Git and GitOps stack created in ${resolvedNs}`, 'ok')
      }
      onClose()
      void manualRefresh()
      schedulePostDeployRefreshes()
      navigate(ROUTES.services)
    } catch (e) {
      pushToast('Deploy failed: ' + (e?.message || String(e)), 'err')
    } finally {
      setDeploying(false)
    }
  }

  const nsStatusColor = nsStatus.tone === 'amber' ? 'var(--amber)'
    : nsStatus.tone === 'green' ? 'var(--green)'
    : nsStatus.tone === 'red' ? 'var(--red)' : 'var(--text-dim)'

  const sel = { width: '100%', background: 'var(--bg)', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: 13, padding: '9px 12px', outline: 'none' }

  return (
    <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="wz-title">
      <div className="modal" style={{ width: step === 3 ? 540 : 480 }}>
        <div className="modal-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
              DEPLOY WIZARD — STEP {step} OF 3
            </div>
            <h3 id="wz-title" style={{ margin: 0 }}>{template.name}</h3>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {catLabel ? (
              <span className="cat-badge" style={{ background: color + '22', color, border: '1px solid ' + color + '44', flexShrink: 0 }}>
                {catLabel}
              </span>
            ) : null}
            <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 2, lineHeight: 1, borderRadius: 4 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {step === 1 && (
          <>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                  You do not have permission to deploy in this environment.
                </div>
              )}
              <div className="field">
                <label>Environment</label>
                <select value={envId} onChange={(e) => setEnvId(e.target.value)} style={sel}>
                  <option value="">— Select environment —</option>
                  {vis.map((e) => <option key={e.Id} value={String(e.Id)}>{e.Name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>
                  Namespace
                  {nsStatus.text ? <span style={{ color: nsStatusColor, fontFamily: 'var(--mono)', fontSize: 11, marginLeft: 8 }}>{nsStatus.text}</span> : null}
                </label>
                {manualNs ? (
                  <input type="text" placeholder="Enter namespace" value={manualNsValue} onChange={(e) => setManualNsValue(e.target.value)} style={sel} />
                ) : (
                  <select value={namespace} onChange={(e) => setNamespace(e.target.value)} disabled={nsLoading || !envId} style={sel}>
                    {!envId && <option value="">Select environment first…</option>}
                    {envId && nsLoading && <option value="">Loading namespaces…</option>}
                    {envId && !nsLoading && nsList.length === 0 && <option value="">No accessible namespaces</option>}
                    {nsList.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                )}
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={onNext} disabled={nsLoading || !envId || !deployPerms.canDeploy} title={!deployPerms.canDeploy ? 'No deploy permission in this environment' : undefined}>Next →</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '16px 18px', lineHeight: 2 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '2px 12px' }}>
                  {[
                    ['TEMPLATE', template.name],
                    ['ENVIRONMENT', env?.Name || envId],
                    ['NAMESPACE', resolvedNs],
                    ['CONTAINERS', containerSummary],
                    ['EXPOSURE', exposureSummary],
                  ].map(([k, v]) => (
                    <>
                      <span key={k + '-k'} style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>{k}</span>
                      <span key={k + '-v'} style={{ color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: 14 }}>{v}</span>
                    </>
                  ))}
                  {gpuSummary ? (
                    <>
                      <span style={{ color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 12 }}>GPU REQUIRED</span>
                      <span style={{ color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600 }}>{gpuSummary}</span>
                    </>
                  ) : null}
                </div>
              </div>
              {itemType === 'helm' ? (
                <HelmValuesEditor
                  helm={template?.helm || {}}
                  releaseName={helmReleaseName}
                  onReleaseNameChange={setHelmReleaseName}
                  values={helmValues}
                  onValuesChange={setHelmValues}
                />
              ) : (
                <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>
                  Default resource limits and environment variables will be applied.{itemType === 'portainer-run' ? ' To customise before deploying, use Customize instead.' : ''}
                </p>
              )}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(1)} disabled={deploying}>← Back</button>
              {(template?.allowCustomise !== false) && itemType !== 'helm' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={onCustomize} disabled={deploying}>Customize</button>
              )}
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setStep(3)} disabled={deploying}>
                {itemType === 'helm' ? 'Review →' : 'Next →'}
              </button>
            </div>
          </>
        )}

        {step === 3 && itemType !== 'helm' && (
          <div className="modal-body" style={{ padding: 0 }}>
            <GitOpsStep
              appName={cfg.name}
              ns={resolvedNs}
              envId={envId}
              deployParams={buildDeployParams()}
              onConfirm={onGitOpsConfirm}
              onBack={() => setStep(2)}
              deploying={deploying}
            />
          </div>
        )}

        {step === 3 && itemType === 'helm' && (
          <>
            <div className="modal-body" style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              Deploy <strong style={{ color: 'var(--text-bright)' }}>{helmReleaseName}</strong> to namespace <strong style={{ color: 'var(--text-bright)' }}>{resolvedNs}</strong> via Portainer Helm stack. No Git target required — Portainer manages the Helm release directly.
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(2)} disabled={deploying}>← Back</button>
              <button type="button" className="btn btn-primary btn-sm"
                onClick={() => void onGitOpsConfirm({})} disabled={deploying}>
                {deploying ? 'Deploying…' : 'Deploy Helm Chart'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
