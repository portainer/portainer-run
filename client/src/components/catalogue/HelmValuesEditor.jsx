
/**
 * Step 2 for helm catalogue items — shows chart info and a values YAML editor.
 */
export function HelmValuesEditor({ helm, releaseName, onReleaseNameChange, values, onValuesChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        background: 'var(--surface2)', border: '1px solid var(--border)',
        borderRadius: 6, padding: '12px 16px',
        display: 'grid', gridTemplateColumns: '100px 1fr', gap: '4px 12px',
        fontFamily: 'var(--mono)', fontSize: 12,
      }}>
        <span style={{ color: 'var(--text-dim)' }}>Chart</span>
        <span style={{ color: 'var(--text-bright)' }}>{helm.chart}</span>
        <span style={{ color: 'var(--text-dim)' }}>Version</span>
        <span style={{ color: 'var(--text-bright)' }}>{helm.version}</span>
        <span style={{ color: 'var(--text-dim)' }}>Repo</span>
        <span style={{ color: 'var(--text-bright)', wordBreak: 'break-all' }}>{helm.repo}</span>
      </div>

      <div className="field">
        <label>Release name</label>
        <input
          type="text"
          value={releaseName}
          onChange={(e) => onReleaseNameChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
          placeholder={helm.chart}
          style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
        />
        <div className="hint">Kubernetes release name. Lowercase, hyphens allowed.</div>
      </div>

      <div className="field">
        <label>Values (YAML)</label>
        <textarea
          value={values}
          onChange={(e) => onValuesChange(e.target.value)}
          rows={12}
          style={{
            fontFamily: 'var(--mono)', fontSize: 12,
            background: 'var(--bg)', border: '1px solid var(--border2)',
            borderRadius: 6, color: 'var(--text)', padding: '10px 12px',
            width: '100%', resize: 'vertical', boxSizing: 'border-box',
          }}
        />
        <div className="hint">Override default chart values. YAML format.</div>
      </div>
    </div>
  )
}
