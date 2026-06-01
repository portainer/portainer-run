export function MBStep1Target({ vis, form, patch, nsList, nsLoading, nsStatus, nsStatusColor, onNext, onCancel, nextDisabled = false }) {
  return (
    <div className="form-section">
      <div className="form-section-head">Step 1 — Target</div>
      <div className="form-section-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="frow" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Deployment target</label>
            <select value={form.envId} onChange={(e) => patch({ envId: e.target.value, namespace: '', manualNs: false, manualNsValue: '' })}>
              <option value="">— Select environment —</option>
              {vis.map((e) => <option key={e.Id} value={e.Id}>{e.Name}</option>)}
            </select>
            <div className="hint">Portainer Kubernetes environment</div>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Namespace</label>
            {!form.manualNs ? (
              <select value={form.namespace} onChange={(e) => patch({ namespace: e.target.value })} disabled={!form.envId || nsLoading}>
                <option value="">{!form.envId ? 'Select target first…' : nsLoading ? 'Loading…' : '— Select —'}</option>
                {nsList.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            ) : (
              <input type="text" value={form.manualNsValue} onChange={(e) => patch({ manualNsValue: e.target.value })} placeholder="my-namespace" />
            )}
            {nsStatus.text && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: nsStatusColor, marginTop: 4 }}>{nsStatus.text}</div>}
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onNext} disabled={!form.envId || nextDisabled}
            title={nextDisabled ? 'No deploy permission in this environment' : undefined}>
            Next →
          </button>
        </div>
      </div>
    </div>
  )
}
