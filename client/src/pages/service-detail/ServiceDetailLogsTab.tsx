import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'

import { Badge } from '@ds/v3-components/Badge/Badge'
import { Button } from '@ds/v3-components/Button/Button'
import { Input } from '@ds/v3-components/FormField/FormField'
import { Select } from '@ds/v3-components/Select/Select'
import { StatusDot } from '@ds/v3-components/StatusDot/StatusDot'

import { kubeFetch, serverFetch } from '../../lib/api.js'
import { inflightDedupe } from '../../lib/inflightDedupe.js'
import { useAppStore } from '../../store/useAppStore.js'
import { getAssistantModel } from '../../lib/assistant/aiModel.js'
import { AssistantMarkdown } from '../../components/AssistantMarkdown.jsx'
import { readTriageSseStream } from '../../lib/assistant/parseStream.js'
import { gatherServiceDiagnostics } from '../../lib/assistant/diagnostics.js'
import { MONO_FONT } from './detailUi'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface LogLine {
  text: string
  cls: string
}

function lineClass(text: string): string {
  if (/error|fatal|panic/i.test(text)) return 'log-err'
  if (/warn/i.test(text)) return 'log-warn'
  return ''
}

const LINE_COLOR: Record<string, string> = {
  'log-err': 'var(--status-danger, #f97066)',
  'log-warn': 'var(--status-warning, #fdb022)',
}

const LOGS_TRIAGE_SYSTEM = `You are an operations assistant helping a user diagnose a containerised application. Use plain English — avoid Kubernetes jargon where possible, and explain technical terms when you must use them.

Diagnostic data may include pod status and conditions, Kubernetes events, and application logs from all instances. Events and pod conditions matter especially when logs are empty or the app failed to start.

Provide a concise diagnostic report covering:
1. Current state of the application in plain terms
2. Any problems identified — cite specific events, conditions, or log lines as evidence
3. Most likely root cause
4. Recommended actions in priority order

If the application is healthy, say so briefly. If logs are empty but events show a problem, focus on the events and container state.`

export function ServiceDetailLogsTab({
  envId,
  namespace,
  name,
}: {
  envId: string
  namespace: string
  name: string
}) {
  const token = useAppStore((s) => s.token)
  const isAiAvailable = useAppStore((s) => s.isAiAvailable)
  const aiProvider = useAppStore((s) => s.aiProvider)
  const [pods, setPods] = useState<{ name: string; containers: string[] }[]>([])
  const [pod, setPod] = useState('')
  const [container, setContainer] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const [lines, setLines] = useState<LogLine[]>([])
  const [outputErr, setOutputErr] = useState('')
  const [busy, setBusy] = useState('')
  const [severity, setSeverity] = useState('all')
  const [search, setSearch] = useState('')
  const [streaming, setStreaming] = useState(false)
  const logLinesRef = useRef<LogLine[]>([])
  const streamCtrl = useRef<AbortController | null>(null)
  const outRef = useRef<HTMLDivElement | null>(null)
  const aiBodyRef = useRef<HTMLDivElement | null>(null)
  const aiTriageInFlight = useRef(false)

  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiOutput, setAiOutput] = useState<null | {
    kind: 'status' | 'markdown' | 'error'
    text: string
    streaming?: boolean
  }>(null)

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
    (source: LogLine[]) => {
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
    (next: LogLine[]) => {
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
        const list = items.map((p: any) => ({
          name: p.metadata.name,
          containers: (p.spec?.containers || []).map((c: any) => c.name),
        }))
        setPods(list)
        setPod(list[0].name)
        setContainer(list[0].containers[0] || '')
      } catch (e: any) {
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
    setAiOutput(null)
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
    setAiOutput({
      kind: 'status',
      text: 'Gathering diagnostics from all instances…',
    })
    try {
      const diag = await gatherServiceDiagnostics(token, dep, {
        logTailLines: 300,
      })
      const podCount = pods.length
      const block =
        diag.trim() ||
        '[No diagnostic data could be collected — check that instances exist and the token can read pods, logs, and events.]'
      const truncated =
        block.length > 90000
          ? '[Earlier content omitted]\n…\n' + block.slice(-90000)
          : block
      const userContent = `Application: ${name}
Namespace: ${namespace}
Instance count: ${podCount}

The following diagnostic data has been gathered from all instances. It includes pod status and conditions, Kubernetes events, and application logs.

${truncated}

Analyse this data and follow the instructions in your system prompt.`

      setAiOutput({ kind: 'status', text: 'Running analysis…' })
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
        let eb: any = {}
        try {
          eb = await response.json()
        } catch {
          /* ignore */
        }
        const err = eb?.error
        const emsg =
          typeof err === 'string' ? err : err?.message || 'HTTP ' + response.status
        throw new Error(emsg)
      }
      const full = await readTriageSseStream(response.body, (acc: string) => {
        setAiOutput({ kind: 'markdown', text: acc, streaming: true })
        const el = aiBodyRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
      setAiOutput({ kind: 'markdown', text: full })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setAiOutput({ kind: 'error', text: msg })
    } finally {
      aiTriageInFlight.current = false
      setAiBusy(false)
    }
  }, [token, envId, namespace, name, isAiAvailable, pods.length])

  const onPodChange = (v: string) => {
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
      const cParam = container ? `&container=${encodeURIComponent(container)}` : ''
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
        .map((t: string) => ({ text: t, cls: lineClass(t) }))
      setLogLines(arr)
    } catch (e: any) {
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
    const cParam = container ? `&container=${encodeURIComponent(container)}` : ''
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
          const next = [
            ...logLinesRef.current,
            { text: line, cls: lineClass(line) },
          ]
          if (next.length > 1000) next.shift()
          logLinesRef.current = next
        }
        renderVisible(logLinesRef.current)
      }
    } catch (e: any) {
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
          <Badge tone="purple" size="sm">
            {aiBadge}
          </Badge>
          <Button
            size="xs"
            onClick={() => void runLogsTriage()}
            disabled={aiBusy || !!loadErr}
          >
            {aiBusy ? 'Analysing…' : 'Analyse with AI'}
          </Button>
        </div>
      ) : null}

      {aiPanelOpen ? (
        <div
          style={{
            marginBottom: 12,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg, 8px)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg)',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
              Analysis — {name}
            </span>
            <Badge tone="purple" size="sm">
              {aiBadge}
            </Badge>
            <Button
              variant="ghost"
              size="xs"
              aria-label="Close analysis"
              onClick={() => {
                setAiPanelOpen(false)
                setAiOutput(null)
              }}
            >
              <X size={12} />
            </Button>
          </div>
          <div
            ref={aiBodyRef}
            style={{
              maxHeight: 360,
              overflowY: 'auto',
              padding: 12,
              fontSize: 13,
            }}
          >
            {!aiOutput ? (
              <span style={{ color: 'var(--muted)' }}>…</span>
            ) : aiOutput.kind === 'status' ? (
              <span style={{ color: 'var(--muted)' }}>{aiOutput.text}</span>
            ) : aiOutput.kind === 'error' ? (
              <p style={{ color: 'var(--status-danger, #f04438)' }}>
                <strong>Analysis failed:</strong> {aiOutput.text}
              </p>
            ) : (
              <AssistantMarkdown>{aiOutput.text}</AssistantMarkdown>
            )}
          </div>
        </div>
      ) : null}

      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg, 8px)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '8px 10px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg)',
          }}
        >
          <Select
            fieldSize="sm"
            value={pod}
            onChange={(e) => onPodChange(e.target.value)}
            disabled={!pods.length}
            options={
              pods.length
                ? pods.map((p) => ({ value: p.name, label: p.name }))
                : [{ value: '', label: 'No instances' }]
            }
          />
          <Select
            fieldSize="sm"
            value={container}
            onChange={(e) => {
              setContainer(e.target.value)
              stopStream()
              setLogLines([])
              setOutputErr('')
            }}
            disabled={!currentContainers.length}
            options={currentContainers.map((c) => ({ value: c, label: c }))}
          />
          <Select
            fieldSize="sm"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            options={[
              { value: 'all', label: 'All lines' },
              { value: 'warn', label: 'Warnings + errors' },
              { value: 'err', label: 'Errors only' },
            ]}
          />
          <Input
            type="search"
            fieldSize="sm"
            placeholder="Filter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 180 }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onFetchOnce()}
            disabled={!pod || busy === 'fetch'}
          >
            {busy === 'fetch' ? 'Fetching…' : 'Fetch last 500'}
          </Button>
          {!streaming ? (
            <Button
              size="sm"
              onClick={() => void onStartStream()}
              disabled={!pod || busy === 'stream'}
            >
              {busy === 'stream' ? 'Connecting…' : 'Stream'}
            </Button>
          ) : (
            <Button color="danger" size="sm" onClick={stopStream}>
              Stop stream
            </Button>
          )}
          {streaming ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <StatusDot tone="success" animation="pulse" />
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Live</span>
            </span>
          ) : null}
        </div>
        {loadErr ? (
          <div
            style={{
              padding: 12,
              color: 'var(--status-warning, #f79009)',
              fontFamily: MONO_FONT,
              fontSize: 12,
            }}
          >
            {loadErr}
          </div>
        ) : (
          <div
            ref={outRef}
            style={{
              padding: 12,
              minHeight: 200,
              maxHeight: 480,
              overflowY: 'auto',
              background: '#0b0e14',
              color: '#c7cdd8',
              fontFamily: MONO_FONT,
              fontSize: 12,
              lineHeight: 1.5,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {outputErr ? (
              <span style={{ color: LINE_COLOR['log-err'] }}>{outputErr}</span>
            ) : !lines.length ? (
              <span style={{ color: 'var(--muted, #667085)' }}>
                {busy
                  ? busy === 'stream'
                    ? 'Connecting stream…'
                    : 'Loading…'
                  : 'Select an instance and container, then Stream or Fetch last 500.'}
              </span>
            ) : (
              lines.map((l, i) => (
                <span
                  key={i}
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    color: LINE_COLOR[l.cls] || undefined,
                  }}
                >
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
