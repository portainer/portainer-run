import { detectClusterGpuType } from '../../lib/deployK8s.js'
import { newId } from '../../lib/deployFormModel.js'

export const envVarGrid = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr 1fr auto auto',
  gap: 6,
  marginBottom: 6,
  alignItems: 'center',
}

export const monoInput = {
  background: 'var(--bg)',
  border: '1px solid var(--border2)',
  borderRadius: 5,
  color: 'var(--text-bright)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  padding: '6px 10px',
  outline: 'none',
  width: '100%',
}

/**
 * @param {object} p
 * @param {Array<{ name: string, keys: string[] }>} p.secretList
 * @param {(fn: (c: object) => object) => void} p.patchC
 */
export function DeployEnvAndEnvFromBlock({ container, patchC, secretList }) {
  function addEnvVar() {
    patchC((c) => ({
      ...c,
      envRows: [
        ...c.envRows,
        { id: newId(), mode: 'plain', key: '', value: '', secretName: '', secretKey: '' },
      ],
    }))
  }

  function addEnvFrom() {
    patchC((c) => ({
      ...c,
      envFrom: [...c.envFrom, { id: newId(), secret: '' }],
    }))
  }

  return (
    <div className="field">
      <label>Environment variables</label>
      <div>
        {container.envRows.map((row) => (
          <div key={row.id} style={envVarGrid} data-mode={row.mode}>
            <input
              type="text"
              placeholder="KEY"
              value={row.key}
              onChange={(e) =>
                patchC((c) => ({
                  ...c,
                  envRows: c.envRows.map((r) =>
                    r.id === row.id ? { ...r, key: e.target.value } : r,
                  ),
                }))
              }
              style={monoInput}
            />
            {row.mode === 'plain' ? (
              <input
                type="text"
                data-env-val
                placeholder="value"
                value={row.value}
                onChange={(e) =>
                  patchC((c) => ({
                    ...c,
                    envRows: c.envRows.map((r) =>
                      r.id === row.id ? { ...r, value: e.target.value } : r,
                    ),
                  }))
                }
                style={monoInput}
              />
            ) : (
              <div
                style={{
                  background: 'var(--surface2)',
                  border: '1px solid var(--border2)',
                  borderRadius: 5,
                  padding: '6px 10px',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  color: 'var(--text-dim)',
                  letterSpacing: 2,
                }}
              >
                ••••••••
              </div>
            )}
            {row.mode === 'plain' ? (
              <div />
            ) : (
              <select
                value={row.secretName && row.secretKey ? `${row.secretName}|||${row.secretKey}` : ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) {
                    patchC((c) => ({
                      ...c,
                      envRows: c.envRows.map((r) =>
                        r.id === row.id ? { ...r, secretName: '', secretKey: '' } : r,
                      ),
                    }))
                    return
                  }
                  const [s, k] = v.split('|||')
                  patchC((c) => ({
                    ...c,
                    envRows: c.envRows.map((r) =>
                      r.id === row.id
                        ? {
                            ...r,
                            secretName: s,
                            secretKey: k,
                            key: r.key || k,
                          }
                        : r,
                    ),
                  }))
                }}
                style={{ ...monoInput, appearance: 'auto' }}
              >
                <option value="">Select secret / key...</option>
                {secretList.map((sec) => (
                  <optgroup key={sec.name} label={sec.name}>
                    {sec.keys.map((k) => (
                      <option key={k} value={`${sec.name}|||${k}`}>
                        {k}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            <button
              type="button"
              title={row.mode === 'secret' ? 'Switch to plain value' : 'Use value from secret'}
              onClick={() =>
                patchC((c) => ({
                  ...c,
                  envRows: c.envRows.map((r) =>
                    r.id === row.id
                      ? {
                          ...r,
                          mode: r.mode === 'secret' ? 'plain' : 'secret',
                          value: r.mode === 'secret' ? '' : r.value,
                          secretName: r.mode === 'plain' ? '' : r.secretName,
                          secretKey: r.mode === 'plain' ? '' : r.secretKey,
                        }
                      : r,
                  ),
                }))
              }
              style={{
                background: 'none',
                border: '1px solid var(--border2)',
                borderRadius: 5,
                cursor: 'pointer',
                padding: '4px 7px',
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: row.mode === 'secret' ? 'var(--accent)' : 'var(--text-dim)',
                whiteSpace: 'nowrap',
              }}
            >
              🔑
            </button>
            <button
              type="button"
              onClick={() =>
                patchC((c) => ({
                  ...c,
                  envRows: c.envRows.filter((r) => r.id !== row.id),
                }))
              }
              style={{
                background: 'none',
                border: '1px solid var(--border2)',
                borderRadius: 5,
                cursor: 'pointer',
                padding: '4px 8px',
                color: 'var(--text-dim)',
                fontSize: 13,
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
          <button type="button" className="add-btn" onClick={addEnvVar}>
            + Add variable
          </button>
          <button
            type="button"
            className="add-btn"
            onClick={addEnvFrom}
            style={{ color: 'var(--accent)' }}
          >
            + Load all from secret
          </button>
        </div>
        {container.envFrom.length ? (
          <div
            style={{
              marginTop: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {container.envFrom.map((ef) => (
              <div
                key={ef.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: 'var(--surface2)',
                    border: '1px solid var(--border2)',
                    borderRadius: 5,
                    padding: '6px 10px',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      color: 'var(--accent)',
                      flexShrink: 0,
                    }}
                  >
                    ALL KEYS FROM
                  </span>
                  <select
                    value={ef.secret}
                    onChange={(e) =>
                      patchC((c) => ({
                        ...c,
                        envFrom: c.envFrom.map((x) =>
                          x.id === ef.id ? { ...x, secret: e.target.value } : x,
                        ),
                      }))
                    }
                    style={{
                      ...monoInput,
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      width: '100%',
                    }}
                  >
                    <option value="">Select secret...</option>
                    {secretList.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    patchC((c) => ({
                      ...c,
                      envFrom: c.envFrom.filter((x) => x.id !== ef.id),
                    }))
                  }
                  style={{
                    background: 'none',
                    border: '1px solid var(--border2)',
                    borderRadius: 5,
                    cursor: 'pointer',
                    padding: '4px 8px',
                    color: 'var(--text-dim)',
                    fontSize: 13,
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="hint">Plain values, single keys from existing secrets, or all keys from a secret</div>
    </div>
  )
}

export function toneColor(tone) {
  if (tone === 'amber') return 'var(--amber)'
  if (tone === 'green') return 'var(--green)'
  if (tone === 'red') return 'var(--red)'
  return 'var(--text-dim)'
}

export function DeployContainerFormCard({ c, onChange, onRemove, secretList, scItems, token, envId, patchContainer }) {
  return (
    <div className="container-card" id={'cc-wrap-' + c.id}>
      <div className="container-card-head">
        <span className="cname">
          {c.isPrimary ? 'Primary container' : 'Sidecar container'}
        </span>
        {c.isPrimary ? <span className="cprimary">primary</span> : null}
        {!c.isPrimary ? (
          <button
            type="button"
            className="btn btn-danger btn-xs"
            style={{ marginLeft: 'auto' }}
            onClick={() => onRemove(c.id)}
          >
            Remove
          </button>
        ) : null}
      </div>
      <div className="container-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="frow" style={{ marginBottom: 0 }}>
          <div className="field">
            <label>Container name</label>
            <input
              type="text"
              value={c.cname}
              onChange={(e) => onChange(c.id, { cname: e.target.value })}
              placeholder={c.isPrimary ? 'app' : 'sidecar'}
            />
          </div>
          <div className="field">
            <label>Image</label>
            <input
              type="text"
              value={c.image}
              onChange={(e) => onChange(c.id, { image: e.target.value })}
              placeholder="nginx:latest"
            />
          </div>
        </div>
        <div className="frow">
          <div className="field">
            <label>CPU request</label>
            <input
              type="text"
              value={c.cpuReq}
              onChange={(e) => onChange(c.id, { cpuReq: e.target.value })}
              placeholder="100m"
            />
          </div>
          <div className="field">
            <label>CPU limit</label>
            <input
              type="text"
              value={c.cpuLim}
              onChange={(e) => onChange(c.id, { cpuLim: e.target.value })}
              placeholder="500m"
            />
          </div>
        </div>
        <div className="frow">
          <div className="field">
            <label>Memory request</label>
            <input
              type="text"
              value={c.memReq}
              onChange={(e) => onChange(c.id, { memReq: e.target.value })}
              placeholder="128Mi"
            />
          </div>
          <div className="field">
            <label>Memory limit</label>
            <input
              type="text"
              value={c.memLim}
              onChange={(e) => onChange(c.id, { memLim: e.target.value })}
              placeholder="512Mi"
            />
          </div>
        </div>
        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <label style={{ margin: 0 }}>GPU</label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: 'var(--text-dim)',
              }}
            >
              <input
                type="checkbox"
                checked={c.gpuEnabled}
                onChange={async (e) => {
                  const on = e.target.checked
                  onChange(c.id, { gpuEnabled: on })
                  if (on && token && envId) {
                    const t = await detectClusterGpuType(token, envId)
                    onChange(c.id, {
                      gpuKey: t.key,
                      gpuLabel: t.label,
                      gpuWarn: t.warn,
                    })
                  } else if (!on) {
                    onChange(c.id, { gpuLabel: '', gpuWarn: undefined })
                  }
                }}
              />
              Request GPU
            </label>
          </div>
          {c.gpuEnabled ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <input
                type="number"
                value={c.gpuCount}
                min={1}
                max={16}
                onChange={(e) => onChange(c.id, { gpuCount: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                style={{
                  width: 70,
                  background: 'var(--bg)',
                  border: '1px solid var(--border2)',
                  borderRadius: 5,
                  color: 'var(--text-bright)',
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  padding: '6px 10px',
                }}
              />
              <span
                id={'gpu-lbl-' + c.id}
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: c.gpuWarn
                    ? toneColor(c.gpuWarn)
                    : 'var(--text-dim)',
                }}
              >
                {c.gpuLabel || (token && envId ? '—' : 'Select an environment first')}
              </span>
            </div>
          ) : null}
        </div>
        <div className="field">
          <label>
            Storage volume <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>(RWO — optional)</span>
          </label>
          {c.volumeOn ? (
            <div id={'vol-en-' + c.id}>
              <div className="volume-row-head">
                <span>Volume name</span>
                <span>Storage type</span>
                <span>Size</span>
                <span>Mount path</span>
                <span />
              </div>
              <div className="volume-row" id={'vol-row-' + c.id}>
                <input
                  type="text"
                  value={c.volName}
                  onChange={(e) => onChange(c.id, { volName: e.target.value })}
                  placeholder={c.isPrimary ? 'app-data' : 'sidecar-data'}
                />
                <select
                  value={c.volClass}
                  onChange={(e) => onChange(c.id, { volClass: e.target.value })}
                >
                  <option value="">Default / none</option>
                  {scItems.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={c.volSizeNum}
                    onChange={(e) => onChange(c.id, { volSizeNum: e.target.value })}
                    style={{ width: 50, minWidth: 0 }}
                  />
                  <select
                    value={c.volSizeUnit}
                    onChange={(e) => onChange(c.id, { volSizeUnit: e.target.value })}
                    style={{ width: 68, minWidth: 0 }}
                  >
                    <option value="Mi">MB</option>
                    <option value="Gi">GB</option>
                    <option value="Ti">TB</option>
                  </select>
                </div>
                <input
                  type="text"
                  value={c.volPath}
                  onChange={(e) => onChange(c.id, { volPath: e.target.value })}
                  placeholder="/data"
                />
                <span />
              </div>
            </div>
          ) : null}
          <button
            type="button"
            className="add-btn"
            onClick={() => onChange(c.id, { volumeOn: !c.volumeOn })}
            style={{ marginTop: 4 }}
          >
            {c.volumeOn ? '− Remove storage volume' : '+ Add storage volume'}
          </button>
          <div className="hint">Creates a persistent volume bound to this container only.</div>
        </div>
        <DeployEnvAndEnvFromBlock
          container={c}
          patchC={(f) => patchContainer(c.id, f)}
          secretList={secretList}
        />
      </div>
    </div>
  )
}

/**
 * @param {object} p
 * @param {string} p.exposeType
 * @param {(v: string) => void} p.setExposeType
 * @param {string[]} p.svcPorts
 * @param {(v: string[] | ((s: string[]) => string[])) => void} p.setSvcPorts
 * @param {string} p.ingHost
 * @param {(s: string) => void} p.setIngHost
 * @param {string} p.ingPath
 * @param {(s: string) => void} p.setIngPath
 * @param {number} p.ingPort
 * @param {(n: number) => void} p.setIngPort
 * @param {string} p.ingClass
 * @param {(s: string) => void} p.setIngClass
 * @param {(v: string) => void} [p.onExposeTypeChange] — if set, called with new type; otherwise use setExposeType
 */
export function DeployExposureFormFields({
  exposeType,
  setExposeType,
  svcPorts,
  setSvcPorts,
  ingHost,
  setIngHost,
  ingPath,
  setIngPath,
  ingPort,
  setIngPort,
  ingClass,
  setIngClass,
  onExposeTypeChange,
}) {
  const onType = (v) => {
    if (onExposeTypeChange) {
      onExposeTypeChange(v)
      return
    }
    setExposeType(v)
    if (v === 'NodePort' || v === 'LoadBalancer') {
      setSvcPorts((s) => (s && s.length ? s : ['80']))
    }
  }
  return (
    <>
      <div className="field" style={{ marginBottom: 16 }}>
        <label>Expose service as</label>
        <select value={exposeType} onChange={(e) => onType(e.target.value)}>
          <option value="none">None — deployment only, no external access</option>
          <option value="NodePort">NodePort — expose on cluster node IP + port</option>
          <option value="LoadBalancer">LoadBalancer — provision external load balancer</option>
          <option value="Ingress">Ingress — route via cluster ingress controller</option>
        </select>
      </div>
      {exposeType === 'NodePort' || exposeType === 'LoadBalancer' ? (
        <div className="field">
          <label>Ports</label>
          {svcPorts.map((port, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <input
                type="number"
                placeholder="e.g. 8080"
                value={port}
                onChange={(e) => {
                  const n = [...svcPorts]
                  n[i] = e.target.value
                  setSvcPorts(n)
                }}
                style={{
                  width: 160,
                  background: 'var(--bg)',
                  border: '1px solid var(--border2)',
                  borderRadius: 5,
                  color: 'var(--text-bright)',
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  padding: '7px 12px',
                  outline: 'none',
                }}
              />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)' }}>
                → same port on LB / auto node port
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                style={{ marginLeft: 'auto' }}
                onClick={() => setSvcPorts(svcPorts.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="add-btn" onClick={() => setSvcPorts((s) => [...s, ''])}>
            + Add port
          </button>
          <div className="hint">Each port is exposed on the same service port. Node ports are assigned automatically.</div>
        </div>
      ) : null}
      {exposeType === 'Ingress' ? (
        <div>
          <div className="frow" style={{ marginBottom: 12 }}>
            <div className="field">
              <label>Hostname</label>
              <input
                type="text"
                value={ingHost}
                onChange={(e) => setIngHost(e.target.value)}
                placeholder="myapp.example.com"
              />
              <div className="hint">Must resolve to your ingress controller</div>
            </div>
            <div className="field">
              <label>Path</label>
              <input
                type="text"
                value={ingPath}
                onChange={(e) => setIngPath(e.target.value)}
                placeholder="/"
              />
            </div>
          </div>
          <div className="frow">
            <div className="field">
              <label>Port</label>
              <input
                type="number"
                value={ingPort}
                onChange={(e) => setIngPort(Math.max(1, parseInt(e.target.value, 10) || 80))}
              />
              <div className="hint">The port your container listens on</div>
            </div>
            <div className="field">
              <label>
                Ingress type <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>(optional)</span>
              </label>
              <input
                type="text"
                value={ingClass}
                onChange={(e) => setIngClass(e.target.value)}
                placeholder="nginx"
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

/**
 * New deploy: service name + instances. Edit: read-only deployment name + instances.
 */
export function DeployNameAndInstancesRow({ mode, serviceName, onServiceNameChange, deploymentName, instances, onInstancesChange }) {
  if (mode === 'edit') {
    return (
      <div className="frow" style={{ marginBottom: 0 }}>
        <div className="field">
          <label>Deployment</label>
          <input
            type="text"
            value={deploymentName || '—'}
            readOnly
            style={{ opacity: 0.88, cursor: 'not-allowed' }}
          />
          <div className="hint">Name and namespace are fixed for this screen</div>
        </div>
        <div className="field">
          <label>Instances</label>
          <input
            type="number"
            value={instances}
            min={0}
            max={100}
            onChange={(e) => onInstancesChange(Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)))}
          />
        </div>
      </div>
    )
  }
  return (
    <div className="frow" style={{ marginBottom: 0 }}>
      <div className="field">
        <label>Service name</label>
        <input
          type="text"
          value={serviceName}
          onChange={(e) => onServiceNameChange(e.target.value)}
          placeholder="my-service"
        />
        <div className="hint">Lowercase, alphanumeric and hyphens</div>
      </div>
      <div className="field">
        <label>Instances</label>
        <input
          type="number"
          value={instances}
          min={0}
          max={100}
          onChange={(e) => onInstancesChange(Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)))}
        />
      </div>
    </div>
  )
}

export function DeployContainersFormList({
  containers,
  onChange,
  onRemove,
  onAddSidecar,
  patchContainer,
  secretList,
  scItems,
  token,
  envId,
}) {
  return (
    <>
      {containers.map((c) => (
        <DeployContainerFormCard
          key={c.id}
          c={c}
          onChange={onChange}
          onRemove={onRemove}
          secretList={secretList}
          scItems={scItems}
          token={token}
          envId={envId}
          patchContainer={patchContainer}
        />
      ))}
      <button type="button" className="add-btn" onClick={onAddSidecar}>
        + Add sidecar container
      </button>
    </>
  )
}
