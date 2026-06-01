import { useState } from 'react'
import { newId } from '../../../lib/deployFormModel.js'
import {
  DEPLOYMENT_TYPES, DATA_ACCESS_POLICIES,
  defaultEnvVar, defaultVolume, defaultService, defaultPlacementRule,
  defaultConfigMapRef, defaultSecretRef,
} from '../../../lib/manifestBuilderModel.js'

function Section({ title, required = false, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mb-section">
      <div className="mb-section-head" onClick={() => setOpen((v) => !v)}>
        <span className={`mb-section-title${required ? ' mb-section-title--required' : ''}`}>{title}</span>
        <svg className={`mb-section-chevron${open ? ' mb-section-chevron--open' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
      {open && <div className="mb-section-body">{children}</div>}
    </div>
  )
}

export function MBStep2App({
  form, patch, secretList, configMapList, pullSecrets,
  storageClasses, gpuInfo, gpuAvailable, nsQuota, onNext, onBack,
  saveMode = false, catalogueWarnings = [],
}) {
  function patchList(key, id, partial) {
    patch({ [key]: form[key].map((item) => item.id === id ? { ...item, ...partial } : item) })
  }
  function removeFromList(key, id) {
    patch({ [key]: form[key].filter((item) => item.id !== id) })
  }

  const monoInput = { fontFamily: 'var(--mono)', fontSize: 12 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      {/* Catalogue preload warnings */}
      {catalogueWarnings.length > 0 && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: 'rgba(251,191,36,0.08)', border: '1px solid var(--amber)',
          borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
            Unsupported fields — not editable in this form
          </div>
          {catalogueWarnings.map((w, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>! {w}</div>
          ))}
        </div>
      )}

      {/* Base — always open */}
      <Section title="Application" required defaultOpen>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="frow" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 2 }}>
              <label>Application name *</label>
              <input type="text" value={form.appName} onChange={(e) => patch({ appName: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
                placeholder="my-app" style={monoInput} />
              <div className="hint">Lowercase, hyphens allowed. Used as the workload and service name.</div>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Deployment type *</label>
              <select value={form.deploymentType} onChange={(e) => patch({ deploymentType: e.target.value })}>
                {DEPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <div className="hint">{DEPLOYMENT_TYPES.find((t) => t.value === form.deploymentType)?.description}</div>
            </div>
          </div>

          {form.deploymentType !== 'DaemonSet' && (
            <div className="field" style={{ maxWidth: 140 }}>
              <label>Instances</label>
              <input type="number" min="0" max="100" value={form.instances}
                onChange={(e) => patch({ instances: parseInt(e.target.value, 10) || 1 })} style={monoInput} />
            </div>
          )}

          <div className="field">
            <label>Note (optional)</label>
            <input type="text" value={form.note} onChange={(e) => patch({ note: e.target.value })}
              placeholder="Describe this application…" />
          </div>
        </div>
      </Section>

      {/* Image — always open */}
      <Section title="Image" required defaultOpen>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <label>Container image *</label>
            <input type="text" value={form.image} onChange={(e) => patch({ image: e.target.value })}
              placeholder="nginx:latest" style={monoInput} />
          </div>
          <div className="frow" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 2 }}>
              <label>Registry credentials</label>
              <select value={form.pullSecret} onChange={(e) => patch({ pullSecret: e.target.value })}>
                <option value="">None (public image)</option>
                {pullSecrets.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <div className="hint">Select an existing imagePullSecret from this namespace for private registries.</div>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Pull policy</label>
              <select value={form.pullPolicy} onChange={(e) => patch({ pullPolicy: e.target.value })}>
                <option value="Always">Always</option>
                <option value="IfNotPresent">IfNotPresent</option>
                <option value="Never">Never</option>
              </select>
            </div>
          </div>
        </div>
      </Section>

      {/* Environment variables */}
      <Section title="Environment variables">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {form.envVars.map((v) => (
            <div key={v.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 6, alignItems: 'center' }}>
              <input type="text" placeholder="KEY" value={v.key}
                onChange={(e) => patchList('envVars', v.id, { key: e.target.value })} style={monoInput} />
              {v.mode === 'plain' ? (
                <input type="text" placeholder="value" value={v.value}
                  onChange={(e) => patchList('envVars', v.id, { value: e.target.value })} style={monoInput} />
              ) : (
                <select value={`${v.secretName}:${v.secretKey}`}
                  onChange={(e) => { const [sn, sk] = e.target.value.split(':'); patchList('envVars', v.id, { secretName: sn, secretKey: sk }) }}>
                  <option value=":">— Select secret key —</option>
                  {secretList.flatMap((s) => s.keys.map((k) => <option key={`${s.name}:${k}`} value={`${s.name}:${k}`}>{s.name} / {k}</option>))}
                </select>
              )}
              <button type="button" className="btn btn-ghost btn-sm"
                onClick={() => patchList('envVars', v.id, { mode: v.mode === 'plain' ? 'secret' : 'plain' })}>
                {v.mode === 'plain' ? '🔒' : '✏️'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeFromList('envVars', v.id)}>✕</button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => patch({ envVars: [...form.envVars, defaultEnvVar()] })}>+ Add variable</button>
        </div>
      </Section>

      {/* ConfigMaps */}
      <Section title="ConfigMaps">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {form.configMapRefs.map((cm) => (
            <div key={cm.id} style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr auto', gap: 8, alignItems: 'center' }}>
              <select value={cm.name} onChange={(e) => patchList('configMapRefs', cm.id, { name: e.target.value })}>
                <option value="">— Select ConfigMap —</option>
                {configMapList.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
              <select value={cm.mode} onChange={(e) => patchList('configMapRefs', cm.id, { mode: e.target.value })}>
                <option value="env">As env vars</option>
                <option value="mount">As filesystem</option>
              </select>
              {cm.mode === 'mount'
                ? <input type="text" placeholder="/config" value={cm.mountPath}
                    onChange={(e) => patchList('configMapRefs', cm.id, { mountPath: e.target.value })} style={monoInput} />
                : <div />
              }
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeFromList('configMapRefs', cm.id)}>✕</button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => patch({ configMapRefs: [...form.configMapRefs, defaultConfigMapRef()] })}>+ Add ConfigMap</button>
        </div>
      </Section>

      {/* Secrets */}
      <Section title="Secrets">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {form.secretRefs.map((sr) => (
            <div key={sr.id} style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr auto', gap: 8, alignItems: 'center' }}>
              <select value={sr.name} onChange={(e) => patchList('secretRefs', sr.id, { name: e.target.value })}>
                <option value="">— Select Secret —</option>
                {secretList.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              <select value={sr.mode} onChange={(e) => patchList('secretRefs', sr.id, { mode: e.target.value })}>
                <option value="env">As env vars</option>
                <option value="mount">As filesystem</option>
              </select>
              {sr.mode === 'mount'
                ? <input type="text" placeholder="/secrets" value={sr.mountPath}
                    onChange={(e) => patchList('secretRefs', sr.id, { mountPath: e.target.value })} style={monoInput} />
                : <div />
              }
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeFromList('secretRefs', sr.id)}>✕</button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => patch({ secretRefs: [...form.secretRefs, defaultSecretRef()] })}>+ Add Secret</button>
        </div>
      </Section>

      {/* Persisted storage */}
      <Section title="Persisted storage">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {form.volumes.map((v) => (
            <div key={v.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                <div className="field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Mount path</label>
                  <input type="text" placeholder="/data" value={v.mountPath}
                    onChange={(e) => patchList('volumes', v.id, { mountPath: e.target.value })} style={monoInput} />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Size (GiB)</label>
                  <input type="number" min="1" value={v.size}
                    onChange={(e) => patchList('volumes', v.id, { size: e.target.value })} style={monoInput} />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Storage class</label>
                  <select value={v.storageClass} onChange={(e) => patchList('volumes', v.id, { storageClass: e.target.value })}>
                    <option value="">Default</option>
                    {storageClasses.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
                  </select>
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Access policy</label>
                  <select value={v.accessPolicy} onChange={(e) => patchList('volumes', v.id, { accessPolicy: e.target.value })}>
                    {DATA_ACCESS_POLICIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginBottom: 2 }}
                  onClick={() => removeFromList('volumes', v.id)}>✕</button>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {DATA_ACCESS_POLICIES.find((p) => p.value === v.accessPolicy)?.description}
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => patch({ volumes: [...form.volumes, defaultVolume()] })}>+ Add volume</button>
        </div>
      </Section>

      {/* Resource reservations */}
      <Section title="Resource reservations" required={nsQuota.requiresLimits || nsQuota.requiresRequests} defaultOpen={nsQuota.requiresLimits || nsQuota.requiresRequests}>
        {(nsQuota.requiresLimits || nsQuota.requiresRequests) && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(251,191,36,0.08)', border: '1px solid var(--amber)', borderRadius: 6, fontSize: 12, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>
            This namespace has a resource quota — limits and requests are required.
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
          {[
            { label: 'Memory request', key: 'memReq', ph: '128Mi' },
            { label: 'Memory limit', key: 'memLim', ph: '512Mi' },
            { label: 'CPU request', key: 'cpuReq', ph: '100m' },
            { label: 'CPU limit', key: 'cpuLim', ph: '500m' },
          ].map(({ label, key, ph }) => (
            <div key={key} className="field" style={{ margin: 0 }}>
              <label>{label}</label>
              <input type="text" placeholder={ph} value={form[key]} onChange={(e) => patch({ [key]: e.target.value })} style={monoInput} />
            </div>
          ))}
        </div>
        {gpuAvailable && (
          <div style={{ marginTop: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={form.gpuEnabled} onChange={(e) => patch({ gpuEnabled: e.target.checked })} />
              Enable GPU ({gpuInfo.label || gpuInfo.key})
            </label>
            {form.gpuEnabled && (
              <div className="field" style={{ marginTop: 10, maxWidth: 120 }}>
                <label>GPU count</label>
                <input type="number" min="1" value={form.gpuCount}
                  onChange={(e) => patch({ gpuCount: parseInt(e.target.value, 10) || 1, gpuKey: gpuInfo.key })} style={monoInput} />
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Auto-scaling — only for Deployment */}
      {form.deploymentType === 'Deployment' && (
        <Section title="Auto-scaling">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, marginBottom: form.autoScalingEnabled ? 14 : 0 }}>
            <input type="checkbox" checked={form.autoScalingEnabled} onChange={(e) => patch({ autoScalingEnabled: e.target.checked })} />
            Enable auto-scaling (requires metrics-server)
          </label>
          {form.autoScalingEnabled && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              {[
                { label: 'Minimum instances', key: 'minInstances' },
                { label: 'Maximum instances', key: 'maxInstances' },
                { label: 'Target CPU %', key: 'targetCpu' },
              ].map(({ label, key }) => (
                <div key={key} className="field" style={{ margin: 0 }}>
                  <label>{label}</label>
                  <input type="number" min="1" value={form[key]}
                    onChange={(e) => patch({ [key]: parseInt(e.target.value, 10) || 1 })} style={monoInput} />
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* Placement */}
      <Section title="Placement rules">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {form.placementRules.map((r) => (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.5fr 1fr auto', gap: 8, alignItems: 'center' }}>
              <input type="text" placeholder="node label key" value={r.key}
                onChange={(e) => patchList('placementRules', r.id, { key: e.target.value })} style={monoInput} />
              <input type="text" placeholder="value" value={r.value}
                onChange={(e) => patchList('placementRules', r.id, { value: e.target.value })} style={monoInput} />
              <select value={r.policy} onChange={(e) => patchList('placementRules', r.id, { policy: e.target.value })}>
                <option value="Mandatory">Mandatory</option>
                <option value="Preferred">Preferred</option>
              </select>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeFromList('placementRules', r.id)}>✕</button>
            </div>
          ))}
          <div className="hint">Mandatory uses nodeSelector. Preferred uses node affinity.</div>
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => patch({ placementRules: [...form.placementRules, defaultPlacementRule()] })}>+ Add rule</button>
        </div>
      </Section>

      {/* Publishing */}
      <Section title="Publishing (services & ingress)">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {form.services.map((svc) => (
            <div key={svc.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: 8, alignItems: 'end', marginBottom: 10 }}>
                <div className="field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Service type</label>
                  <select value={svc.type} onChange={(e) => patchList('services', svc.id, { type: e.target.value })}>
                    <option value="ClusterIP">ClusterIP</option>
                    <option value="NodePort">NodePort</option>
                    <option value="LoadBalancer">LoadBalancer</option>
                  </select>
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Container port</label>
                  <input type="number" placeholder="80" value={svc.containerPort}
                    onChange={(e) => patchList('services', svc.id, { containerPort: e.target.value })} style={monoInput} />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Service port</label>
                  <input type="number" placeholder="80" value={svc.servicePort}
                    onChange={(e) => patchList('services', svc.id, { servicePort: e.target.value })} style={monoInput} />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Protocol</label>
                  <select value={svc.protocol} onChange={(e) => patchList('services', svc.id, { protocol: e.target.value })}>
                    <option value="TCP">TCP</option>
                    <option value="UDP">UDP</option>
                  </select>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginBottom: 2 }}
                  onClick={() => removeFromList('services', svc.id)}>✕</button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, marginBottom: svc.ingressEnabled ? 10 : 0 }}>
                <input type="checkbox" checked={svc.ingressEnabled}
                  onChange={(e) => patchList('services', svc.id, { ingressEnabled: e.target.checked })} />
                Add Ingress rule for this service
              </label>
              {svc.ingressEnabled && (
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginTop: 8 }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label style={{ fontSize: 11 }}>Hostname</label>
                    <input type="text" placeholder="app.example.com" value={svc.ingressHost}
                      onChange={(e) => patchList('services', svc.id, { ingressHost: e.target.value })} style={monoInput} />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label style={{ fontSize: 11 }}>Path</label>
                    <input type="text" placeholder="/" value={svc.ingressPath}
                      onChange={(e) => patchList('services', svc.id, { ingressPath: e.target.value })} style={monoInput} />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label style={{ fontSize: 11 }}>Ingress class</label>
                    <input type="text" placeholder="nginx" value={svc.ingressClass}
                      onChange={(e) => patchList('services', svc.id, { ingressClass: e.target.value })} style={monoInput} />
                  </div>
                </div>
              )}
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => patch({ services: [...form.services, defaultService()] })}>+ Add service</button>
        </div>
      </Section>

      {/* Annotations */}
      <Section title="Annotations">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {form.annotations.map((a) => (
            <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, alignItems: 'center' }}>
              <input type="text" placeholder="annotation key" value={a.key}
                onChange={(e) => patchList('annotations', a.id, { key: e.target.value })} style={monoInput} />
              <input type="text" placeholder="value" value={a.value}
                onChange={(e) => patchList('annotations', a.id, { value: e.target.value })} style={monoInput} />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeFromList('annotations', a.id)}>✕</button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => patch({ annotations: [...form.annotations, { id: newId(), key: '', value: '' }] })}>+ Add annotation</button>
        </div>
      </Section>

      {!saveMode && (
        <div className="form-actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onBack}>← Back</button>
          <button type="button" className="btn btn-primary" onClick={onNext}>Next: Git Target →</button>
        </div>
      )}
    </div>
  )
}
