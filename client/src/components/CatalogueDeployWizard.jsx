import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore, visibleEnvironments, isEnvDisabled } from '../store/useAppStore.js'
import { ROUTES } from '../lib/routes.js'
import { parseKnativeManifest, CATALOGUE_CATEGORY_COLORS, CATALOGUE_CATEGORY_LABELS } from '../lib/catalogueTemplate.js'
import { fetchNamespaceOptions, executeDeploy, createExposureForApp } from '../lib/deployK8s.js'
import { manualRefresh } from '../services/refreshDeployments.js'

/**
 * Two-step Deploy Wizard modal — matches the original portainer-run.html UX.
 *
 * Step 1: pick environment + namespace
 * Step 2: confirm summary → Deploy Now | Customize | ← Back
 *
 * @param {object} props
 * @param {{ id: string, name: string, category?: string, manifest?: object } | null} props.template
 * @param {() => void} props.onClose
 */
export function CatalogueDeployWizard({ template, onClose }) {
  const navigate = useNavigate()
  const token = useAppStore((s) => s.token)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const baseDomain = useAppStore((s) => s.baseDomain)
  const pushToast = useAppStore((s) => s.pushToast)

  const vis = visibleEnvironments({ environments, disabledEnvs })

  const [step, setStep] = useState(1)
  const [envId, setEnvId] = useState(() => (vis[0] ? String(vis[0].Id) : ''))
  const [nsList, setNsList] = useState([])
  const [namespace, setNamespace] = useState('')
  const [manualNs, setManualNs] = useState(false)
  const [manualNsValue, setManualNsValue] = useState('')
  const [nsStatus, setNsStatus] = useState({ text: '', tone: 'dim' })
  const [nsLoading, setNsLoading] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const loadedEnvRef = useRef('')

  const resolvedNs = manualNs ? manualNsValue.trim() : namespace

  // Load namespaces when envId changes
  const loadNamespaces = useCallback(async (eid) => {
    if (!eid || !token) return
    if (loadedEnvRef.current === eid) return
    loadedEnvRef.current = eid
    setNsLoading(true)
    setNsStatus({ text: 'Loading…', tone: 'dim' })
    setNsList([])
    setNamespace('')
    setManualNs(false)
    setManualNsValue('')
    try {
      const r = await fetchNamespaceOptions(token, eid)
      if (r.ok && r.manual) {
        setManualNs(true)
        setNsStatus({ text: r.message || 'Enter namespace manually', tone: 'amber' })
      } else if (r.ok) {
        setNsList(r.namespaces)
        const def = r.namespaces.find((n) => n === 'default') || r.namespaces[0] || ''
        setNamespace(def)
        setNsStatus({ text: r.message || '', tone: 'green' })
      } else {
        setManualNs(true)
        setNsStatus({ text: (r && r.error) || 'Could not load namespaces', tone: 'red' })
      }
    } catch (e) {
      setManualNs(true)
      setNsStatus({ text: (e && e.message) || 'Error', tone: 'red' })
    } finally {
      setNsLoading(false)
    }
  }, [token])

  // Auto-load namespaces on open and when envId changes
  useEffect(() => {
    loadedEnvRef.current = ''
    if (envId) void loadNamespaces(envId)
  }, [envId, loadNamespaces])

  // Reset to step 1 when template changes
  useEffect(() => {
    setStep(1)
    loadedEnvRef.current = ''
    const firstEnvId = vis[0] ? String(vis[0].Id) : ''
    setEnvId(firstEnvId)
    setNsList([])
    setNamespace('')
    setManualNs(false)
    setManualNsValue('')
    setNsStatus({ text: '', tone: 'dim' })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.id])

  if (!template) return null

  const cfg = parseKnativeManifest(template.manifest || {}, { baseDomain })
  const color = CATALOGUE_CATEGORY_COLORS[template.category] || 'var(--text-dim)'
  const catLabel = CATALOGUE_CATEGORY_LABELS[template.category] || template.category || ''
  const env = environments.find((e) => String(e.Id) === String(envId))

  // Build summary values for Step 2
  const containerSummary = (template.manifest?.spec?.template?.spec?.containers || [])
    .map((c) => c.image || c.name)
    .join(', ') || '—'

  let exposureSummary = 'None'
  if (cfg.exposure && cfg.exposure.type !== 'none') {
    if (cfg.exposure.type === 'Ingress' && cfg.exposure.host) {
      exposureSummary = `Ingress → ${cfg.exposure.host}`
    } else if (cfg.exposure.ports?.length) {
      exposureSummary = `${cfg.exposure.type} port ${cfg.exposure.ports.join(', ')}`
    } else if (cfg.exposure.port) {
      exposureSummary = `${cfg.exposure.type} port ${cfg.exposure.port}`
    } else {
      exposureSummary = cfg.exposure.type
    }
  }

  const gpuContainers = cfg.containers.filter((c) => c.gpuKey && c.gpuCount > 0)
  const gpuSummary = gpuContainers.length
    ? gpuContainers.map((c) => `${c.gpuCount}× ${c.gpuKey.split('/')[1] || c.gpuKey}`).join(', ')
    : null

  function onNext() {
    if (!envId) { pushToast('Select an environment', 'err'); return }
    if (isEnvDisabled({ disabledEnvs }, envId)) {
      pushToast('This environment has been disabled by an administrator — no new deployments allowed', 'err')
      return
    }
    if (!resolvedNs) { pushToast('Select or enter a namespace', 'err'); return }
    setStep(2)
  }

  function onBack() {
    setStep(1)
  }

  function onCustomize() {
    onClose()
    navigate(ROUTES.deploy, {
      state: {
        catalogueTemplate: template,
        wizardEnvId: envId,
        wizardNs: resolvedNs,
      },
    })
  }

  async function onDeployNow() {
    if (!envId || !resolvedNs) return
    setDeploying(true)
    try {
      // Build PVC + container + volume structures from cfg
      const containerRowIds = cfg.containers.map((_, i) => `wz-ct-${i}`)
      const containerSpecs = cfg.containers.map((ct, i) => {
        const spec = {
          name: ct.name,
          image: ct.image,
          imagePullPolicy: 'Always',
        }
        const res = {
          requests: { cpu: ct.cpuReq, memory: ct.memReq },
          limits: { cpu: ct.cpuLim, memory: ct.memLim },
        }
        if (ct.gpuKey && ct.gpuCount > 0) {
          res.limits[ct.gpuKey] = String(ct.gpuCount)
          res.requests[ct.gpuKey] = String(ct.gpuCount)
        }
        spec.resources = res
        if (ct.env?.length) spec.env = ct.env
        if (ct.storage) {
          spec.volumeMounts = [{ name: ct.storage.name, mountPath: ct.storage.mountPath }]
        }
        return spec
      })

      const volumeDefs = cfg.containers
        .filter((ct) => ct.storage)
        .map((ct, i) => ({
          containerId: containerRowIds[cfg.containers.indexOf(ct)],
          name: ct.storage.name,
          size: ct.storage.size || '1Gi',
          mountPath: ct.storage.mountPath,
        }))

      const exposeType = cfg.exposure?.type === 'Ingress' ? 'Ingress'
        : cfg.exposure?.type === 'LoadBalancer' ? 'LoadBalancer'
        : cfg.exposure?.type === 'NodePort' ? 'NodePort'
        : 'none'

      const servicePorts = cfg.exposure?.ports?.length
        ? cfg.exposure.ports
        : cfg.exposure?.port
          ? [cfg.exposure.port]
          : [80]

      await executeDeploy(token, {
        envId,
        ns: resolvedNs,
        appName: cfg.name,
        instances: cfg.instances || 1,
        containerSpecs,
        containerRowIds,
        volumeDefs,
        exposeType,
        servicePorts,
        ingress: {
          host: cfg.exposure?.host || '',
          path: '/',
          port: cfg.exposure?.port || servicePorts[0] || 80,
          ingressClass: '',
        },
      })

      pushToast(`"${cfg.name}" deployed to ${resolvedNs} — ${containerSpecs.length} container(s)`, 'ok')
      onClose()
      void manualRefresh()
      navigate(ROUTES.services)
    } catch (e) {
      pushToast('Deploy failed: ' + (e?.message || String(e)), 'err')
    } finally {
      setDeploying(false)
    }
  }

  const toneStyle = (tone) => ({
    color: tone === 'amber' ? 'var(--amber)' : tone === 'green' ? 'var(--green)' : tone === 'red' ? 'var(--red)' : 'var(--text-dim)',
    fontFamily: 'var(--mono)',
    fontSize: 12,
    marginTop: 4,
  })

  const selectStyle = {
    width: '100%',
    background: 'var(--bg)',
    border: '1px solid var(--border2)',
    borderRadius: 6,
    color: 'var(--text-bright)',
    fontFamily: 'var(--mono)',
    fontSize: 13,
    padding: '9px 12px',
    outline: 'none',
  }

  return (
    <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="wz-title">
      <div className="modal" style={{ width: 480 }}>

        {/* Header */}
        <div className="modal-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
              DEPLOY WIZARD
            </div>
            <h3 id="wz-title" style={{ margin: 0 }}>{template.name}</h3>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {catLabel ? (
              <span
                className="cat-badge"
                style={{
                  background: color + '22',
                  color,
                  border: '1px solid ' + color + '44',
                  flexShrink: 0,
                }}
              >
                {catLabel}
              </span>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-dim)',
                padding: 2,
                lineHeight: 1,
                borderRadius: 4,
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Step 1: Environment + Namespace */}
        {step === 1 && (
          <>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="field">
                <label>Environment</label>
                <select
                  value={envId}
                  onChange={(e) => {
                    loadedEnvRef.current = ''
                    setEnvId(e.target.value)
                  }}
                  style={selectStyle}
                >
                  {vis.length === 0 && <option value="">No environments available</option>}
                  {vis.map((e) => (
                    <option key={e.Id} value={String(e.Id)}>{e.Name}</option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label>
                  Namespace
                  {nsStatus.text ? (
                    <span style={{ ...toneStyle(nsStatus.tone), display: 'inline', marginLeft: 8 }}>
                      {nsStatus.text}
                    </span>
                  ) : null}
                </label>
                {manualNs ? (
                  <input
                    type="text"
                    placeholder="Enter namespace"
                    value={manualNsValue}
                    onChange={(e) => setManualNsValue(e.target.value)}
                    style={selectStyle}
                  />
                ) : (
                  <select
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                    disabled={nsLoading || !envId}
                    style={selectStyle}
                  >
                    {nsLoading && <option value="">Loading…</option>}
                    {!nsLoading && nsList.length === 0 && <option value="">Select environment first…</option>}
                    {nsList.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="modal-foot">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={onNext} disabled={nsLoading}>
                Next →
              </button>
            </div>
          </>
        )}

        {/* Step 2: Confirm summary */}
        {step === 2 && (
          <>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '16px 18px',
                lineHeight: 2,
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '2px 12px' }}>
                  <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>TEMPLATE</span>
                  <span style={{ color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: 14 }}>{template.name}</span>

                  <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>ENVIRONMENT</span>
                  <span style={{ color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: 14 }}>{env?.Name || envId}</span>

                  <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>NAMESPACE</span>
                  <span style={{ color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: 14 }}>{resolvedNs}</span>

                  <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>CONTAINERS</span>
                  <span style={{ color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: 14 }}>{containerSummary}</span>

                  <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>EXPOSURE</span>
                  <span style={{ color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: 14 }}>{exposureSummary}</span>

                  {gpuSummary ? (
                    <>
                      <span style={{ color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 12 }}>GPU REQUIRED</span>
                      <span style={{ color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600 }}>{gpuSummary}</span>
                    </>
                  ) : null}
                </div>
              </div>

              <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>
                Default resource limits and environment variables will be applied. To customise before deploying, use <strong style={{ color: 'var(--text)' }}>Customize</strong> instead.
              </p>
            </div>

            <div className="modal-foot">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onBack} disabled={deploying}>
                ← Back
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCustomize} disabled={deploying}>
                Customize
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void onDeployNow()} disabled={deploying}>
                {deploying ? (
                  <><span className="spinner" style={{ width: 12, height: 12, display: 'inline-block', marginRight: 6 }} />Deploying…</>
                ) : 'Deploy Now'}
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  )
}
