import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchTemplatesJson } from '../lib/fetchTemplatesJson.js'
import { inflightDedupe } from '../lib/inflightDedupe.js'
import {
  CATALOGUE_CATEGORY_COLORS,
  CATALOGUE_CATEGORY_LABELS,
  CATALOGUE_TYPE_COLORS,
  CATALOGUE_TYPE_LABELS,
  getCatalogueItemType,
} from '../lib/catalogueTemplate.js'
import { CatalogueDeployWizard } from './CatalogueDeployWizard.jsx'

/**
 * @typedef {{ id: string, name: string, description?: string, category?: string, manifest?: object }} CatalogueEntry
 */

function containerCount(t) {
  return t.manifest?.spec?.template?.spec?.containers?.length || 1
}

function firstPort(t) {
  return t.manifest?.spec?.template?.spec?.containers?.[0]?.ports?.[0]?.containerPort || 80
}

export function CataloguePage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** @type {[CatalogueEntry[], function]} */
  const [templates, setTemplates] = useState([])
  const [filterCat, setFilterCat] = useState('all')
  const [filterType, setFilterType] = useState('all')
  const [wizardTemplate, setWizardTemplate] = useState(/** @type {CatalogueEntry | null} */ (null))

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await inflightDedupe('catalogue:templates-json', () =>
        fetchTemplatesJson(),
      )
      setTemplates(data.templates || [])
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      setError(err.message)
      setTemplates([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const categories = useMemo(() => {
    const set = new Set(templates.map((t) => t.category).filter(Boolean))
    return ['all', ...set]
  }, [templates])

  const filtered = useMemo(() => {
    return templates.filter((t) => {
      if (filterCat !== 'all' && t.category !== filterCat) return false
      if (filterType !== 'all' && getCatalogueItemType(t) !== filterType) return false
      return true
    })
  }, [templates, filterCat, filterType])

  function openWizard(t) {
    setWizardTemplate(t)
  }

  return (
    <div className="page active">
      <div className="page-header" style={{ alignItems: 'center' }}>
        <div>
          <div className="page-title">Catalogue</div>
          <div className="page-sub">Pre-built application templates — Simple Deploy, Kubernetes manifests, and Helm charts. Deploy in one click or customise before deploying.</div>
        </div>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--text-dim)',
            alignSelf: 'center',
          }}
        >
          {loading ? '…' : `${templates.length} template${templates.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {error ? (
        <div
          style={{
            color: 'var(--red)',
            fontFamily: 'var(--mono)',
            fontSize: 13,
            padding: '32px 0',
            lineHeight: 1.6,
          }}
        >
          Could not load catalogue: {error}
          <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 8 }}>
            Set <code style={{ color: 'var(--accent)' }}>TEMPLATE_URL</code> in{' '}
            <code style={{ color: 'var(--accent)' }}>.env</code> to a full <code style={{ color: 'var(--accent)' }}>https://…</code> URL
            of the catalogue JSON (same idea as the old UI: e.g. raw GitHub). Not{' '}
            <code style={{ color: 'var(--accent)' }}>/templates</code> — that path is only this app’s proxy.
          </div>
        </div>
      ) : null}

      {!error && !loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
            {categories.map((cat) => {
              const active = cat === filterCat
              return (
                <button
                  key={cat}
                  type="button"
                  className={'cat-filter-btn' + (active ? ' active' : '')}
                  onClick={() => setFilterCat(cat)}
                >
                  {CATALOGUE_CATEGORY_LABELS[cat] || (cat === 'all' ? 'All' : cat)}
                </button>
              )
            })}
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 12,
              background: 'var(--surface2)', border: '1px solid var(--border2)',
              borderRadius: 6, color: filterType !== 'all' ? CATALOGUE_TYPE_COLORS[filterType] : 'var(--text-dim)',
              padding: '5px 10px', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <option value="all">All types</option>
            {['portainer-run', 'kubernetes', 'helm'].map((type) => (
              <option key={type} value={type}>{CATALOGUE_TYPE_LABELS[type] || type}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 16,
        }}
      >
        {loading ? (
          <div
            style={{
              color: 'var(--text-dim)',
              fontFamily: 'var(--mono)',
              fontSize: 13,
              gridColumn: '1 / -1',
              padding: '40px 0',
              textAlign: 'center',
            }}
          >
            <div className="spinner" style={{ margin: '0 auto 12px' }} />
            Loading catalogue…
          </div>
        ) : null}

        {!loading && !error && !filtered.length ? (
          <div
            style={{
              color: 'var(--text-dim)',
              fontFamily: 'var(--mono)',
              fontSize: 13,
              gridColumn: '1 / -1',
              padding: '40px 0',
              textAlign: 'center',
            }}
          >
            No templates in this category.
          </div>
        ) : null}

        {!loading && !error
          ? filtered.map((t) => {
              const color = CATALOGUE_CATEGORY_COLORS[t.category] || 'var(--text-dim)'
              const cc = containerCount(t)
              const port = firstPort(t)
              return (
                <div key={t.id} className="cat-card">
                  <div className="cat-card-head">
                    <div className="cat-card-name">{t.name || t.id}</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <span
                        className="cat-badge"
                        style={{
                          background: CATALOGUE_TYPE_COLORS[getCatalogueItemType(t)] + '22',
                          color: CATALOGUE_TYPE_COLORS[getCatalogueItemType(t)],
                          border: '1px solid ' + CATALOGUE_TYPE_COLORS[getCatalogueItemType(t)] + '44',
                        }}
                      >
                        {CATALOGUE_TYPE_LABELS[getCatalogueItemType(t)] || getCatalogueItemType(t)}
                      </span>
                      <span
                        className="cat-badge"
                        style={{
                          background: color + '22',
                          color,
                          border: '1px solid ' + color + '44',
                        }}
                      >
                        {t.category
                          ? CATALOGUE_CATEGORY_LABELS[t.category] || t.category
                          : '—'}
                      </span>
                    </div>
                  </div>
                  <div className="cat-card-desc">{t.description || '—'}</div>
                  <div className="cat-card-meta">
                    {getCatalogueItemType(t) === 'helm' ? (
                      <>
                        <span>{t.helm?.chart}</span>
                        <span>v{t.helm?.version}</span>
                      </>
                    ) : getCatalogueItemType(t) === 'kubernetes' ? (
                      <>
                        <span>Kubernetes manifest</span>
                      </>
                    ) : (
                      <>
                        <span>{cc} container{cc !== 1 ? 's' : ''}</span>
                        <span>port {port}</span>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary cat-deploy-btn"
                    onClick={() => openWizard(t)}
                  >
                    Deploy Wizard
                  </button>
                </div>
              )
            })
          : null}
      </div>

      <CatalogueDeployWizard
        template={wizardTemplate}
        onClose={() => setWizardTemplate(null)}
      />
    </div>
  )
}
