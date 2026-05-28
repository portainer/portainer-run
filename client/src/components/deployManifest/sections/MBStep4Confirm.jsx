import { useState } from 'react'
import { gitOpsValidate } from '../../../lib/gitTargets.js'
import { DEPLOYMENT_TYPES } from '../../../lib/manifestBuilderModel.js'

export function MBStep4Confirm({ form, ns, deploying, onDeploy, onBack }) {
  const [validating, setValidating] = useState(false)
  const [validateResults, setValidateResults] = useState(null)
  const [validateError, setValidateError] = useState('')

  const deployType = DEPLOYMENT_TYPES.find((t) => t.value === form.deploymentType)

  async function handleValidate() {
    setValidating(true)
    setValidateResults(null)
    setValidateError('')
    try {
      const r = await gitOpsValidate({
        manifestBuilderParams: { ...form, namespace: ns },
        envId: form.envId,
      })
      setValidateResults(r.results || [])
    } catch (e) {
      setValidateError('Validation failed: ' + (e?.message || 'Unknown error'))
    } finally {
      setValidating(false)
    }
  }

  const validateAllPassed = validateResults && validateResults.every((r) => r.status !== 'fail')

  // Summary of resources that will be created
  const resources = []
  resources.push(`${deployType?.label || form.deploymentType} — ${form.appName}`)
  if (form.volumes?.length) resources.push(`${form.volumes.length} PersistentVolumeClaim(s)`)
  if (form.services?.length) {
    for (const svc of form.services) {
      resources.push(`Service (${svc.type})${svc.containerPort ? ` — port ${svc.containerPort}` : ''}`)
      if (svc.ingressEnabled) resources.push(`Ingress${svc.ingressHost ? ` — ${svc.ingressHost}` : ''}`)
    }
  }
  if (form.autoScalingEnabled && form.deploymentType === 'Deployment') {
    resources.push(`HorizontalPodAutoscaler — ${form.minInstances}–${form.maxInstances} instances`)
  }

  return (
    <div className="form-section">
      <div className="form-section-head">Step 4 — Dry-run & Deploy</div>
      <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Summary */}
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 18px' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10 }}>
            Deployment summary
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '4px 16px', fontSize: 13 }}>
            {[
              ['Application', form.appName],
              ['Namespace', ns],
              ['Image', form.image],
              ['Git branch', form._branch],
              ['Git path', `${form._pathPrefix ? form._pathPrefix + '/' : ''}${ns}/${form.appName}.yaml`],
            ].map(([k, v]) => v ? (
              <>
                <span key={k} style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>{k}</span>
                <span key={k + 'v'} style={{ color: 'var(--text-bright)', fontFamily: 'var(--mono)', fontSize: 13 }}>{v}</span>
              </>
            ) : null)}
          </div>
        </div>

        {/* Resources to be created */}
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>
            Resources to be created
          </div>
          {resources.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontFamily: 'var(--mono)', color: 'var(--text)', marginBottom: 4 }}>
              <span style={{ color: 'var(--accent)', fontSize: 11 }}>▸</span> {r}
            </div>
          ))}
        </div>

        {/* Dry-run */}
        <div>
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => void handleValidate()} disabled={validating || deploying}
            style={{ marginBottom: 8 }}>
            {validating ? 'Validating…' : 'Dry-run validate'}
          </button>
          <div className="hint">Checks manifests against the Kubernetes API without creating anything.</div>

          {validateError && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>{validateError}</div>}

          {validateResults && (
            <div style={{
              marginTop: 10, background: 'var(--surface2)',
              border: `1px solid ${validateAllPassed ? 'var(--green)' : 'var(--red)'}`,
              borderRadius: 6, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              {validateResults.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 12 }}>
                  <span style={{ flexShrink: 0, fontFamily: 'var(--mono)', color: r.status === 'pass' ? 'var(--green)' : r.status === 'warn' ? 'var(--amber)' : 'var(--red)' }}>
                    {r.status === 'pass' ? '✓' : r.status === 'warn' ? '!' : '✕'}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', flexShrink: 0 }}>{r.kind}/{r.name}</span>
                  <span style={{ color: r.status === 'pass' ? 'var(--text-dim)' : r.status === 'warn' ? 'var(--amber)' : 'var(--red)' }}>{r.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onBack} disabled={deploying}>← Back</button>
          <button type="button" className="btn btn-primary" onClick={() => void onDeploy()} disabled={deploying}>
            {deploying
              ? <><span className="spinner" style={{ width: 14, height: 14, display: 'inline-block' }} /> Deploying…</>
              : 'Commit & Deploy'}
          </button>
        </div>
      </div>
    </div>
  )
}
