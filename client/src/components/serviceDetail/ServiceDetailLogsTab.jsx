import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { kubeFetch, serverFetch } from '../../lib/api.js'
import { inflightDedupe } from '../../lib/inflightDedupe.js'
import { useAppStore } from '../../store/useAppStore.js'
import { getAssistantModel } from '../../lib/assistant/aiModel.js'
import { mdToHtml } from '../../lib/assistant/markdown.js'
import { readTriageSseStream } from '../../lib/assistant/parseStream.js'
import { gatherServiceDiagnostics } from '../../lib/assistant/diagnostics.js'

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
const LOGS_TRIAGE_SYSTEM = `You are an operations assistant helping a user diagnose a containerised application. Use plain English — avoid Kubernetes jargon where possible, and explain technical terms when you must use them.

Diagnostic data may include pod status and conditions, Kubernetes events, and application logs from all instances. Events and pod conditions matter especially when logs are empty or the app failed to start.

Provide a concise diagnostic report covering:
1. Current state of the application in plain terms
2. Any problems identified — cite specific events, conditions, or log lines as evidence
3. Most likely root cause
4. Recommended actions in priority order

If the application is healthy, say so briefly. If logs are empty but events show a problem, focus on the events and container state.`

export default function ServiceDetailLogsTab({ envId, namespace, name }) {
  const token = useAppStore((s) => s.token)
  const isAiAvailable = useAppStore((s) => s.isAiAvailable)
  const aiProvider = useAppStore((s) => s.aiProvider)
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
  const aiBodyRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const aiTriageInFlight = useRef(false)

  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiHtml, setAiHtml] = useState('')

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

  useEffect(() => {
    setAiPanelOpen(false)
    setAiHtml('')
    setAiBusy(false)
    aiTriageInFlight.current = false
  }, [envId, namespace, name])

  const runLogsTriage = useCallback(async () => {
    if (!token || !envId || !namespace || !name || !isAiAvailable) return
    if (aiTriageInFlight.current) return
    aiTriageInFlight.current = true
    const dep = { _envId: envId, metadata: { name, namespace } }
    setAiBusy(true)
    setAiPanelOpen(true)
    setAiHtml('<span style="color:var(--text-dim)">Gathering diagnostics from all instances…</span>')
    try {
      const diag = await gatherServiceDiagnostics(token, dep, { logTailLines: 300 })
      const podCount = pods.length
      const block =
        diag.trim() ||
        '[No diagnostic data could be collected — check that instances exist and the token can read pods, logs, and events.]'
      const truncated = block.length > 90000 ? '[Earlier content omitted]\n…\n' + block.slice(-90000) : block
      const userContent = `Application: ${name}
Namespace: ${namespace}
Instance count: ${podCount}

The following diagnostic data has been gathered from all instances. It includes pod status and conditions, Kubernetes events, and application logs.

${truncated}

Analyse this data and follow the instructions in your system prompt.`

      setAiHtml('<span style="color:var(--text-dim)">Running analysis…</span>')
      const response = await serverFetch('/ai/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: getAssistantModel(),
          max_tokens: 2000,
          stream: true,
          system: LOGS_TRIAGE_SYSTEM,
          messages: [{ role: 'user', content: userContent }],
        }),
      })
      if (!response.ok) {
        let eb = {}
        try {
          eb = await response.json()
        } catch {
          /* ignore */
        }
        const err = eb?.error
        const emsg = typeof err === 'string' ? err : err?.message || 'HTTP ' + response.status
        throw new Error(emsg)
      }
      const full = await readTriageSseStream(response.body, (acc) => {
        setAiHtml(mdToHtml(acc) + '<span class="ai-cursor"></span>')
        const el = aiBodyRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
      setAiHtml(mdToHtml(full))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const safe = msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      setAiHtml(`<p style="color:var(--red)"><strong>Analysis failed:</strong> ${safe}</p>`)
    } finally {
      aiTriageInFlight.current = false
      setAiBusy(false)
    }
  }, [token, envId, namespace, name, isAiAvailable, pods.length])

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
      const r = await kubeFetch(token, envId, path, { signal: controller.signal })
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

  const aiBadge = aiProvider === 'openai' ? 'OpenAI' : 'Claude'

  return (
    <div>
      {isAiAvailable ? (
        <div
          style={{
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <span className="ai-badge">{aiBadge}</span>
          <button
            type="button"
            className="btn btn-primary btn-xs"
            onClick={() => void runLogsTriage()}
            disabled={aiBusy || !!loadErr}
          >
            {aiBusy ? 'Analysing…' : 'Analyse with AI'}
          </button>
        </div>
      ) : null}

      {aiPanelOpen ? (
        <div className="ai-panel" style={{ marginBottom: 12 }}>
          <div className="ai-panel-head">
            <span className="ai-panel-title">Analysis — {name}</span>
            <span className="ai-badge">{aiBadge}</span>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setAiPanelOpen(false)
                setAiHtml('')
              }}
            >
              ✕
            </button>
          </div>
          <div
            ref={aiBodyRef}
            className="ai-body"
            style={{ maxHeight: 360, overflowY: 'auto' }}
            dangerouslySetInnerHTML={{
              __html: aiHtml || '<span style="color:var(--text-dim)">…</span>',
            }}
          />
        </div>
      ) : null}

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
    </div>
  )
}
