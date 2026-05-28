import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore, visibleEnvironments } from '../store/useAppStore.js'
import { checkEnvPermissions } from '../lib/envPermissions.js'
import { icons } from '../design-system/icons.js'
import { age } from '../lib/utils.js'
import {
  createOpaquePortainerSecret,
  deleteNamespacedSecret,
  fetchNamespaceOptions,
  fetchSecretUsageFromManagedDeployments,
  fetchSecretsInNamespace,
} from '../lib/deployK8s.js'
import { inflightDedupe } from '../lib/inflightDedupe.js'

function newRowId() {
  return `sk-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function SecretsPage() {
  const token = useAppStore((s) => s.token)
  const envPermissions = useAppStore((s) => s.envPermissions)
  const patchEnvPermissions = useAppStore((s) => s.patchEnvPermissions)
  const environments = useAppStore((s) => s.environments)
  const disabledEnvs = useAppStore((s) => s.disabledEnvs)
  const pushToast = useAppStore((s) => s.pushToast)

  const vis = useMemo(
    () => visibleEnvironments({ environments, disabledEnvs }),
    [environments, disabledEnvs],
  )

  const [listEnvId, setListEnvId] = useState('')
  const [nsList, setNsList] = useState([])
  const [nsManual, setNsManual] = useState(false)
  const [nsValue, setNsValue] = useState('')
  const [nsLoading, setNsLoading] = useState(false)
  const [nsHint, setNsHint] = useState('')

  const [secrets, setSecrets] = useState([])
  const [usage, setUsage] = useState({})
  const [loadState, setLoadState] = useState('idle')
  const [loadError, setLoadError] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [formEnvId, setFormEnvId] = useState('')
  const [formNsList, setFormNsList] = useState([])
  const [formNsManual, setFormNsManual] = useState(false)
  const [formNsValue, setFormNsValue] = useState('')
  const [formNamespace, setFormNamespace] = useState('')
  const [formName, setFormName] = useState('')
  const [formKeys, setFormKeys] = useState(() => [{ id: newRowId(), key: '', value: '' }])
  const [formNsLoading, setFormNsLoading] = useState(false)
  const [formNsHint, setFormNsHint] = useState('')
  const [saving, setSaving] = useState(false)

  const [showPw, setShowPw] = useState({})
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!vis.length) {
      setListEnvId('')
      return
    }
    setListEnvId((prev) => (prev && vis.some((e) => String(e.Id) === String(prev)) ? prev : String(vis[0].Id)))
  }, [vis])

  const resolvedListNs = nsManual ? nsValue.trim() : nsValue

  const loadNsForList = useCallback(
    async (eid) => {
      if (!eid || !token) {
        setNsList([])
        setNsManual(true)
        setNsValue('')
        return
      }
      setNsLoading(true)
      setNsHint('')
      try {
        const r = await fetchNamespaceOptions(token, eid)
        if (r.ok && r.manual) {
          setNsList([])
          setNsManual(true)
          setNsValue('')
          setNsHint(r.message || '')
        } else if (r.ok) {
          setNsList(r.namespaces)
          setNsManual(false)
          setNsValue(r.namespaces.find((n) => n === 'default') || r.namespaces[0] || '')
          setNsHint(r.message || '')
        } else {
          setNsList([])
          setNsManual(true)
          setNsValue('')
          setNsHint((r && r.error) || 'Could not list namespaces')
        }
      } catch (e) {
        setNsList([])
        setNsManual(true)
        setNsValue('')
        setNsHint((e && e.message) || 'Error')
      } finally {
        setNsLoading(false)
      }
    },
    [token],
  )

  useEffect(() => {
    if (listEnvId) void loadNsForList(listEnvId)
  }, [listEnvId, loadNsForList])

  const loadSecrets = useCallback(async () => {
    if (!listEnvId || !resolvedListNs) {
      setSecrets([])
      setUsage({})
      setLoadState('idle')
      setLoadError('')
      return
    }
    setLoadState('loading')
    setLoadError('')
    try {
      const [items, u] = await inflightDedupe(
        `secrets-page:${listEnvId}:${resolvedListNs}`,
        async () =>
          Promise.all([
            fetchSecretsInNamespace(token, listEnvId, resolvedListNs),
            fetchSecretUsageFromManagedDeployments(token, listEnvId, resolvedListNs),
          ]),
      )
      setSecrets(items)
      setUsage(u)
      setLoadState('ok')
    } catch (e) {
      setLoadError((e && e.message) || String(e))
      setSecrets([])
      setUsage({})
      setLoadState('err')
    }
  }, [listEnvId, token, resolvedListNs])

  useEffect(() => {
    void loadSecrets()
  }, [loadSecrets])

  const loadFormNs = useCallback(
    async (eid) => {
      if (!eid || !token) {
        setFormNsList([])
        setFormNsManual(true)
        setFormNamespace('')
        return
      }
      setFormNsLoading(true)
      setFormNsHint('')
      try {
        const r = await fetchNamespaceOptions(token, eid)
        if (r.ok && r.manual) {
          setFormNsList([])
          setFormNsManual(true)
          setFormNamespace('')
          setFormNsValue('')
          setFormNsHint(r.message || '')
        } else if (r.ok) {
          setFormNsList(r.namespaces)
          setFormNsManual(false)
          const def = r.namespaces.find((n) => n === 'default') || r.namespaces[0] || ''
          setFormNamespace(def)
          setFormNsHint(r.message || '')
        } else {
          setFormNsList([])
          setFormNsManual(true)
          setFormNamespace('')
          setFormNsValue('')
          setFormNsHint((r && r.error) || 'Failed')
        }
      } catch (e) {
        setFormNsList([])
        setFormNsManual(true)
        setFormNamespace('')
        setFormNsHint((e && e.message) || 'Error')
      } finally {
        setFormNsLoading(false)
      }
    },
    [token],
  )

  const openCreate = useCallback(() => {
    setFormName('')
    setFormKeys([{ id: newRowId(), key: '', value: '' }])
    const eid = listEnvId || (vis[0] ? String(vis[0].Id) : '')
    setFormEnvId(eid)
    setCreateOpen(true)
  }, [listEnvId, vis])

  useEffect(() => {
    if (!createOpen) return
    if (formEnvId) void loadFormNs(formEnvId)
  }, [createOpen, formEnvId, loadFormNs])

  const resolvedFormNs = formNsManual ? formNsValue.trim() : formNamespace

  // Permission checks — fire when both env and namespace are known
  const listPerms = (listEnvId && resolvedListNs) ? (envPermissions[`${listEnvId}:${resolvedListNs}`] || { canCreateSecret: true, canDeleteSecret: true }) : { canCreateSecret: true, canDeleteSecret: true }
  const formPerms = (formEnvId && resolvedFormNs) ? (envPermissions[`${formEnvId}:${resolvedFormNs}`] || { canCreateSecret: true }) : { canCreateSecret: true }

  useEffect(() => {
    if (!listEnvId || !resolvedListNs || !token) return
    const key = `${listEnvId}:${resolvedListNs}`
    if (envPermissions[key] !== undefined) return
    void checkEnvPermissions(token, listEnvId, resolvedListNs)
      .then((p) => patchEnvPermissions(listEnvId, resolvedListNs, p))
  }, [listEnvId, resolvedListNs])

  useEffect(() => {
    if (!formEnvId || !resolvedFormNs || !token) return
    const key = `${formEnvId}:${resolvedFormNs}`
    if (envPermissions[key] !== undefined) return
    void checkEnvPermissions(token, formEnvId, resolvedFormNs)
      .then((p) => patchEnvPermissions(formEnvId, resolvedFormNs, p))
  }, [formEnvId, resolvedFormNs])

  async function saveNewSecret() {
    if (!formEnvId) {
      pushToast('Select an environment', 'err')
      return
    }
    if (!resolvedFormNs) {
      pushToast('Select or enter a namespace', 'err')
      return
    }
    const name = formName.trim().toLowerCase()
    if (!name) {
      pushToast('Secret name is required', 'err')
      return
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      pushToast('Name must be lowercase letters, numbers, and hyphens', 'err')
      return
    }
    const dataPlain = {}
    for (const row of formKeys) {
      const k = row.key.trim()
      if (!k) {
        pushToast('Every credential key must have a name', 'err')
        return
      }
      dataPlain[k] = row.value
    }
    if (!Object.keys(dataPlain).length) {
      pushToast('Add at least one credential', 'err')
      return
    }
    setSaving(true)
    try {
      await createOpaquePortainerSecret(token, formEnvId, resolvedFormNs, name, dataPlain)
      pushToast(`Secret “${name}” saved`, 'ok')
      setCreateOpen(false)
      if (formEnvId === listEnvId && resolvedFormNs === resolvedListNs) {
        void loadSecrets()
      }
    } catch (e) {
      pushToast('Failed to save secret: ' + ((e && e.message) || e), 'err')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const r = await deleteNamespacedSecret(
        token,
        deleteTarget.envId,
        deleteTarget.ns,
        deleteTarget.name,
      )
      if (!r.ok && r.status !== 404) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j?.message || 'HTTP ' + r.status)
      }
      pushToast(`Secret “${deleteTarget.name}” deleted`, 'ok')
      setDeleteTarget(null)
      void loadSecrets()
    } catch (e) {
      pushToast('Delete failed: ' + ((e && e.message) || e), 'err')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="page active">
      <div className="page-header" style={{ alignItems: 'center' }}>
        <div>
          <div className="page-title">Secrets</div>
          <div className="page-sub">Kubernetes Secret objects in a namespace. Values are write-only after save.</div>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => openCreate()} disabled={!vis.length || !listPerms.canCreateSecret} title={!listPerms.canCreateSecret ? 'No permission to create secrets in this namespace' : undefined}>
          + New Secret
        </button>
      </div>

      {vis.length ? (
        <>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>
            Showing secrets in
          </div>
          <div
            className="frow"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24, maxWidth: 640 }}
          >
            <div className="field">
              <label>Environment</label>
              <select value={listEnvId} onChange={(e) => setListEnvId(e.target.value)} disabled={nsLoading}>
                {vis.map((e) => (
                  <option key={e.Id} value={String(e.Id)}>
                    {e.Name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Namespace</label>
              {nsManual ? (
                <>
                  <input
                    type="text"
                    placeholder="my-namespace"
                    value={nsValue}
                    onChange={(e) => setNsValue(e.target.value)}
                  />
                  {nsHint ? <div className="hint">{nsHint}</div> : null}
                </>
              ) : (
                <select
                  value={nsValue}
                  onChange={(e) => setNsValue(e.target.value)}
                  disabled={nsLoading}
                >
                  {nsList.length ? (
                    nsList.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))
                  ) : (
                    <option value="">{nsLoading ? 'Loading namespaces…' : '—'}</option>
                  )}
                </select>
              )}
            </div>
          </div>

          {listEnvId && !resolvedListNs && !nsLoading ? (
            <div
              style={{
                color: 'var(--text-dim)',
                fontFamily: 'var(--mono)',
                fontSize: 13,
                marginBottom: 20,
              }}
            >
              {nsManual
                ? 'Type the namespace to list secrets.'
                : 'Select a namespace, or wait for the list to load.'}
            </div>
          ) : null}

          {resolvedListNs && loadState === 'loading' && (
            <div style={{ color: 'var(--text-dim)', textAlign: 'center', padding: '30px 0' }}>
              <div className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle' }} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, marginLeft: 8 }}>Loading secrets…</span>
            </div>
          )}

          {resolvedListNs && loadState === 'err' && (
            <div style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 13, textAlign: 'center', padding: 24 }}>
              Could not load secrets: {loadError}
            </div>
          )}

          {resolvedListNs && loadState === 'ok' && !secrets.length && (
            <div className="empty" style={{ padding: 40 }}>
              <span
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: icons.lockSmall || '' }}
              />
              <h3>No secrets yet</h3>
              <p>Create a secret to store credentials and sensitive config safely.</p>
            </div>
          )}

          {resolvedListNs && loadState === 'ok' && Boolean(secrets.length) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {secrets.map((s) => {
                const name = s.metadata?.name
                if (!name) return null
                const keys = Object.keys(s.data || {})
                const used = usage[name] || []
                const created = s.metadata?.creationTimestamp
                return (
                  <div
                    key={name}
                    className="cat-card"
                    style={{ flexDirection: 'row', alignItems: 'center' }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600, color: 'var(--text-bright)' }}>
                        {name}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '8px 12px',
                          fontFamily: 'var(--mono)',
                          fontSize: 11,
                          color: 'var(--text-dim)',
                          marginTop: 4,
                        }}
                      >
                        <span>
                          {keys.length} credential{keys.length === 1 ? '' : 's'}
                          {keys.length ? ': ' : ''}
                          {keys.join(', ')}
                        </span>
                        {used.length > 0 ? (
                          <span style={{ color: 'var(--green)' }}>Used by: {used.join(', ')}</span>
                        ) : (
                          <span>Not used by any app</span>
                        )}
                        <span>Created {age(created)} ago</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger btn-xs"
                      disabled={!listPerms.canDeleteSecret}
                      title={!listPerms.canDeleteSecret ? 'No permission to delete secrets in this namespace' : undefined}
                      style={!listPerms.canDeleteSecret ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                      onClick={() => listPerms.canDeleteSecret && setDeleteTarget({ envId: listEnvId, ns: resolvedListNs, name })}
                    >
                      Delete
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </>
      ) : (
        <div className="empty" style={{ padding: 32 }}>
          <h3>No environments</h3>
          <p>Connect to a Portainer instance to manage secrets.</p>
        </div>
      )}

      {createOpen && (
        <div
          className="modal-overlay open"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-secret-title"
        >
          <div className="modal" style={{ width: 660, maxWidth: '95vw' }}>
            <div className="modal-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 id="new-secret-title">New Secret</h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCreateOpen(false)}
                disabled={saving}
                style={{ minWidth: 'auto' }}
              >
                ×
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="field">
                <label>Environment</label>
                <select
                  value={formEnvId}
                  onChange={(e) => {
                    setFormEnvId(e.target.value)
                    void loadFormNs(e.target.value)
                  }}
                  disabled={saving}
                >
                  {vis.map((e) => (
                    <option key={e.Id} value={String(e.Id)}>
                      {e.Name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Namespace{formNsHint ? ` — ${formNsHint}` : ''}</label>
                {formNsManual ? (
                  <input
                    type="text"
                    placeholder="my-namespace"
                    value={formNsValue}
                    onChange={(e) => setFormNsValue(e.target.value)}
                    disabled={saving}
                  />
                ) : formNsList.length > 0 ? (
                  <select
                    value={formNamespace}
                    onChange={(e) => setFormNamespace(e.target.value)}
                    disabled={saving || formNsLoading}
                  >
                    {formNsList.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select disabled>
                    <option value="">{formNsLoading ? 'Loading namespaces…' : '—'}</option>
                  </select>
                )}
              </div>
              <div className="field">
                <label>Secret name</label>
                <input
                  type="text"
                  placeholder="e.g. app-db-creds"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  autoComplete="off"
                  disabled={saving}
                />
              </div>
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}
                >
                  <span className="field-label" style={{ margin: 0 }}>
                    Credentials
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() =>
                      setFormKeys((prev) => [...prev, { id: newRowId(), key: '', value: '' }])
                    }
                    disabled={saving}
                  >
                    + Add
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {formKeys.map((row) => (
                    <div
                      key={row.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '200px 1fr 36px',
                        gap: 8,
                        alignItems: 'flex-start',
                      }}
                    >
                      <textarea
                        placeholder="Key (e.g. DB_PASSWORD)"
                        value={row.key}
                        onChange={(e) =>
                          setFormKeys((prev) =>
                            prev.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)),
                          )
                        }
                        autoComplete="off"
                        disabled={saving}
                        rows={2}
                        style={{
                          width: '100%',
                          background: 'var(--bg)',
                          border: '1px solid var(--border2)',
                          borderRadius: 6,
                          color: 'var(--text-bright)',
                          fontFamily: 'var(--mono)',
                          fontSize: 12,
                          padding: '7px 10px',
                          resize: 'vertical',
                          minHeight: 36,
                          boxSizing: 'border-box',
                        }}
                      />
                      <div style={{ position: 'relative' }}>
                        <textarea
                          placeholder="Value"
                          value={row.value}
                          onChange={(e) =>
                            setFormKeys((prev) =>
                              prev.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)),
                            )
                          }
                          disabled={saving}
                          rows={2}
                          style={{
                            width: '100%',
                            background: 'var(--bg)',
                            border: '1px solid var(--border2)',
                            borderRadius: 6,
                            color: showPw[row.id] ? 'var(--text-bright)' : 'transparent',
                            caretColor: 'var(--text-bright)',
                            textShadow: showPw[row.id] ? 'none' : '0 0 8px var(--text-dim)',
                            fontFamily: 'var(--mono)',
                            fontSize: 12,
                            padding: '7px 44px 7px 10px',
                            resize: 'vertical',
                            minHeight: 36,
                            boxSizing: 'border-box',
                          }}
                        />
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() =>
                            setShowPw((p) => ({ ...p, [row.id]: !p[row.id] }))
                          }
                          style={{
                            position: 'absolute',
                            right: 8,
                            top: 8,
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-dim)',
                            cursor: 'pointer',
                            fontFamily: 'var(--mono)',
                            fontSize: 10,
                            textTransform: 'uppercase',
                            padding: 0,
                          }}
                        >
                          {showPw[row.id] ? 'hide' : 'show'}
                        </button>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ minWidth: 32, width: 32, padding: 0, marginTop: 4 }}
                        onClick={() => setFormKeys((prev) => prev.filter((r) => r.id !== row.id))}
                        disabled={saving || formKeys.length < 2}
                        title="Remove row"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCreateOpen(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveNewSecret()} disabled={saving}>
                {saving ? 'Saving…' : 'Save Secret'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          className="modal-overlay open"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-secret-title"
        >
          <div className="modal">
            <div className="modal-head">
              <h3 id="delete-secret-title">Delete secret</h3>
            </div>
            <div className="modal-body">
              Delete <strong>{deleteTarget.name}</strong>?
              <p style={{ marginTop: 10, color: 'var(--text-dim)', fontSize: 13 }}>
                Any apps using this secret will lose access to its values.
              </p>
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
