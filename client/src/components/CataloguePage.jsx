import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchTemplatesJson } from '../lib/fetchTemplatesJson.js'
import { inflightDedupe } from '../lib/inflightDedupe.js'
import { useNavigate } from 'react-router-dom'
import { ROUTES } from '../lib/routes.js'
import {
  CATALOGUE_CATEGORY_COLORS,
  CATALOGUE_CATEGORY_LABELS,
} from '../lib/catalogueTemplate.js'

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
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** @type {[CatalogueEntry[], function]} */
  const [templates, setTemplates] = useState([])
  const [filterCat, setFilterCat] = useState('all')

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
    if (filterCat === 'all') return templates
    return templates.filter((t) => t.category === filterCat)
  }, [templates, filterCat])

  function goDeploy(t) {
    navigate(ROUTES.deploy, { state: { catalogueTemplate: t } })
  }

  return (
    <div className="page active">
      <div className="page-header" style={{ alignItems: 'center' }}>
        <div>
          <div className="page-title">Catalogue</div>
          <div className="page-sub">Pre-built Knative-style templates. Open in Deploy to choose environment and namespace.</div>
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
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
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
                  <div className="cat-card-desc">{t.description || '—'}</div>
                  <div className="cat-card-meta">
                    <span>
                      {cc} container{cc !== 1 ? 's' : ''}
                    </span>
                    <span>port {port}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary cat-deploy-btn"
                    onClick={() => goDeploy(t)}
                  >
                    Use in Deploy
                  </button>
                </div>
              )
            })
          : null}
      </div>
    </div>
  )
}
