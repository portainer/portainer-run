import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { kubeFetch, portainerUrlHeaders } from '../../lib/api.js'
import { inflightDedupe } from '../../lib/inflightDedupe.js'
import { useAppStore } from '../../store/useAppStore.js'

function lineClass(text) {
  if (/error|fatal|panic/i.test(text)) return 'log-err'
  if (/warn/i.test(text)) return 'log-warn'
  return ''
}

/**
 * @param {object} props
 * @param {string} props.envId
 * @param {string} props.namespace
 * @param {string} props.name deployment name (app label)
 */
export default function ServiceDetailLogsTab({ envId, namespace, name }) {
  const token = useAppStore((s) => s.token)
  const [pods, setPods] = useState(/** @type {{ name: string, containers: string[] }[]} */ ([]))
  const [pod, setPod] = useState('')
  const [container, setContainer] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const [lines, setLines] = useState(/** @type {{ text: string, cls: string }[]} */ [])
  const [outputErr, setOutputErr] = useState('')
  const [busy, setBusy] = useState('')
  const [severity, setSeverity] = useState('all')
  const [search, setSearch] = useState('')
  const [streaming, setStreaming] = useState(false)
  const logLinesRef = useRef(/** @type {{ text: string, cls: string }[]} */ ([]))
  const streamCtrl = useRef(/** @type {AbortController | null} */ (null))
  const outRef = useRef(/** @type {HTMLDivElement | null} */ (null))

  const stopStream = useCallback(() => {
    if (streamCtrl.current) {
      try {
        streamCtrl.current.abort()
      } catch {
        /* ignore */
      }
      streamCtrl.current = null
    }
    setStreaming(false)
  }, [])

  const renderVisible = useCallback(
    (source) => {
      const sev = severity
      const q = search.toLowerCase()
      const visible = source.filter(({ text }) => {
        if (sev === 'err' && !/error|fatal|panic/i.test(text)) return false
        if (sev === 'warn' && !/error|fatal|panic|warn/i.test(text)) return false
        if (q && !text.toLowerCase().includes(q)) return false
        return true
      })
      setLines(visible)
    },
    [search, severity],
  )

  const setLogLines = useCallback(
    (next) => {
      logLinesRef.current = next
      renderVisible(next)
    },
    [renderVisible],
  )

  useEffect(() => {
    renderVisible(logLinesRef.current)
  }, [renderVisible, severity, search])

  useEffect(() => {
    if (!lines.length) return
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  useEffect(() => {
    if (!token || !envId || !namespace || !name) return
    let cancelled = false
    setLoadErr('')
    setPods([])
    setPod('')
    setContainer('')

    ;(async () => {
      try {
        const items = await inflightDedupe(
          `logs:pods:${envId}:${namespace}:${name}`,
          async () => {
            const r = await kubeFetch(
              token,
              envId,
              `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent('app=' + name)}`,
            )
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return (await r.json()).items || []
          },
        )
        if (cancelled) return
        if (!items.length) {
          setLoadErr('No instances found for this app label.')
          return
        }
        const list = items.map((p) => ({
          name: p.metadata.name,
          containers: (p.spec?.containers || []).map((c) => c.name),
        }))
        setPods(list)
        setPod(list[0].name)
        setContainer(list[0].containers[0] || '')
      } catch (e) {
        if (!cancelled) setLoadErr(e?.message || 'Failed to list pods')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [token, envId, namespace, name])

  useEffect(() => {
    return () => stopStream()
  }, [stopStream])

  const onPodChange = (v) => {
    setPod(v)
    const p = pods.find((x) => x.name === v)
    setContainer(p?.containers[0] || '')
    stopStream()
    setLogLines([])
    setOutputErr('')
  }

  const onFetchOnce = async () => {
    if (!pod) return
    stopStream()
    setOutputErr('')
    setBusy('fetch')
    setLogLines([])
    try {
      const cParam = container
        ? `&container=${encodeURIComponent(container)}`
        : ''
      const r = await kubeFetch(
        token,
        envId,
        `/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(pod)}/log?tailLines=500${cParam}`,
      )
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const text = await r.text()
      const arr = text
        .split('\n')
        .filter(Boolean)
        .map((t) => ({ text: t, cls: lineClass(t) }))
      setLogLines(arr)
    } catch (e) {
      setOutputErr(e?.message || 'Failed')
    } finally {
      setBusy('')
    }
  }

  const onStartStream = async () => {
    if (!pod) return
    stopStream()
    setOutputErr('')
    setLogLines([])
    setBusy('stream')
    const cParam = container
      ? `&container=${encodeURIComponent(container)}`
      : ''
    const path = `/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(pod)}/log?follow=true&tailLines=100${cParam}`

    const controller = new AbortController()
    streamCtrl.current = controller
    setStreaming(true)

    try {
      const r = await fetch(
        `/portainer-api/endpoints/${envId}/kubernetes${path}`,
        {
          headers: { 'X-API-Key': token, ...portainerUrlHeaders() },
          signal: controller.signal,
        },
      )
      if (!r.ok) throw new Error('HTTP ' + r.status)
      if (!r.body) throw new Error('No response body')
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      setBusy('')
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n')
        buf = parts.pop() || ''
        for (const line of parts) {
          if (!line) continue
          const next = [...logLinesRef.current, { text: line, cls: lineClass(line) }]
          if (next.length > 1000) next.shift()
          logLinesRef.current = next
        }
        renderVisible(logLinesRef.current)
      }
    } catch (e) {
      if (e?.name !== 'AbortError') {
        setOutputErr('Stream ended: ' + (e?.message || String(e)))
      }
    } finally {
      stopStream()
      setBusy('')
    }
  }

  const currentContainers = useMemo(() => {
    const p = pods.find((x) => x.name === pod)
    return p?.containers || []
  }, [pods, pod])

  return (
    <div className="log-terminal">
      <div className="log-toolbar">
        <select
          value={pod}
          onChange={(e) => onPodChange(e.target.value)}
          disabled={!pods.length}
        >
          {!pods.length && <option value="">No instances</option>}
          {pods.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={container}
          onChange={(e) => {
            setContainer(e.target.value)
            stopStream()
            setLogLines([])
            setOutputErr('')
          }}
          disabled={!currentContainers.length}
        >
          {currentContainers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="log-severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          <option value="all">All lines</option>
          <option value="warn">Warnings + errors</option>
          <option value="err">Errors only</option>
        </select>
        <input
          type="search"
          className="log-search"
          placeholder="Filter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void onFetchOnce()}
          disabled={!pod || busy === 'fetch'}
        >
          {busy === 'fetch' ? 'Fetching…' : 'Fetch last 500'}
        </button>
        {!streaming ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void onStartStream()}
            disabled={!pod || busy === 'stream'}
          >
            {busy === 'stream' ? 'Connecting…' : 'Stream'}
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-danger" onClick={stopStream}>
            Stop stream
          </button>
        )}
        {streaming ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="live-dot" />
            <span
              className="rev-age"
              style={{ color: 'var(--text-dim)', fontSize: 12 }}
            >
              Live
            </span>
          </span>
        ) : null}
      </div>
      {loadErr ? (
        <div className="log-body" style={{ color: 'var(--amber)' }}>
          {loadErr}
        </div>
      ) : (
        <div ref={outRef} className="log-body" id="dpLogOutput">
          {outputErr ? (
            <span className="log-err">{outputErr}</span>
          ) : !lines.length ? (
            <span style={{ color: 'var(--text-dim)' }}>
              {busy
                ? busy === 'stream'
                  ? 'Connecting stream…'
                  : 'Loading…'
                : 'Select an instance and container, then Stream or Fetch last 500.'}
            </span>
          ) : (
            lines.map((l, i) => (
              <span key={i} className={`log-line ${l.cls}`}>
                {l.text}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  )
}
