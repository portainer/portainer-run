import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Alert } from '@ds/v3-components/Alert/Alert'
import { Button } from '@ds/v3-components/Button/Button'
import { StatusDot } from '@ds/v3-components/StatusDot/StatusDot'

import { kubeFetch } from '../../lib/api.js'
import { inflightDedupe } from '../../lib/inflightDedupe.js'
import { useAppStore } from '../../store/useAppStore.js'
import {
  barColor,
  fmtCpu,
  fmtMem,
  parseCpuToMilli,
  parseMemToBytes,
  pct,
} from '../../lib/k8sMetrics.js'
import { MONO_FONT } from './detailUi'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Point {
  t: number
  v: number
}
interface History {
  cpu: Point[]
  mem: Point[]
}

export function ServiceDetailMetricsTab({
  d,
  envId,
  namespace,
  name,
}: {
  d: any
  envId: string
  namespace: string
  name: string
}) {
  const token = useAppStore((s) => s.token)
  const historyRef = useRef<Record<string, Record<string, History>>>({})
  const [tick, setTick] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const [polling, setPolling] = useState(true)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const bump = useCallback(() => setTick((t) => t + 1), [])

  const fetchSample = useCallback(async () => {
    if (!token || !envId || !namespace || !name) return
    try {
      const { status, data } = await inflightDedupe(
        `metrics-pods:${envId}:${namespace}:${name}`,
        async () => {
          const r = await kubeFetch(
            token,
            envId,
            `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`,
          )
          if (r.status === 404 || r.status === 503) {
            return { status: r.status, data: null }
          }
          if (!r.ok) {
            return { status: r.status, data: null }
          }
          return { status: r.status, data: await r.json() }
        },
      )
      if (status === 404 || status === 503) {
        setUnavailable(true)
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
        setPolling(false)
        return
      }
      if (!data) return

      const now = Date.now()
      const cutoff = now - 10 * 60 * 1000
      const hist = historyRef.current

      const pods = (data.items || []).filter(
        (p: any) =>
          p.metadata?.labels?.app === name ||
          (p.metadata?.name && String(p.metadata.name).startsWith(name + '-')),
      )

      for (const pod of pods) {
        const podName = pod.metadata.name
        if (!hist[podName]) hist[podName] = {}
        for (const container of pod.containers || []) {
          const cName = container.name
          if (!hist[podName][cName]) {
            hist[podName][cName] = { cpu: [], mem: [] }
          }
          const b = hist[podName][cName]
          const cpuRaw = container.usage?.cpu || '0'
          const cpuMilli = parseCpuToMilli(cpuRaw)
          const memRaw = container.usage?.memory || '0'
          const memBytes = parseMemToBytes(memRaw)
          b.cpu.push({ t: now, v: cpuMilli })
          b.mem.push({ t: now, v: memBytes })
          b.cpu = b.cpu.filter((p) => p.t >= cutoff)
          b.mem = b.mem.filter((p) => p.t >= cutoff)
        }
      }
      setUnavailable(false)
      bump()
    } catch {
      /* transient */
    }
  }, [token, envId, namespace, name, bump])

  useEffect(() => {
    historyRef.current = {}
    setUnavailable(false)
    setPolling(true)
  }, [envId, namespace, name])

  useEffect(() => {
    if (!polling) return
    void fetchSample()
    timerRef.current = setInterval(() => {
      void fetchSample()
    }, 15000)
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [fetchSample, polling, envId, namespace, name])

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setPolling(false)
  }, [])

  const startPolling = useCallback(() => {
    setUnavailable(false)
    setPolling(true)
  }, [])

  const containerSpecs = d?.spec?.template?.spec?.containers || []

  const limitsMap = useMemo(() => {
    const m: Record<string, { cpuLimit: number; memLimit: number }> = {}
    for (const cs of containerSpecs) {
      m[cs.name] = {
        cpuLimit: parseCpuToMilli(cs.resources?.limits?.cpu || ''),
        memLimit: parseMemToBytes(cs.resources?.limits?.memory || ''),
      }
    }
    return m
  }, [containerSpecs])

  const aggregated = useMemo(() => {
    const out: Record<string, History> = {}
    for (const podHistory of Object.values(historyRef.current)) {
      for (const [cName, h] of Object.entries(podHistory)) {
        if (!out[cName]) out[cName] = { cpu: [], mem: [] }
        h.cpu.forEach((p) => out[cName].cpu.push(p))
        h.mem.forEach((p) => out[cName].mem.push(p))
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const containerOrder = containerSpecs.map((cs: any) => cs.name)
  const sortedContainers = useMemo(() => {
    const keys = Object.keys(aggregated)
    return [
      ...containerOrder.filter((n: string) => keys.includes(n)),
      ...keys.filter((n) => !containerOrder.includes(n)),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggregated])

  return (
    <div>
      <div
        style={{
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          justifyContent: 'flex-start',
        }}
      >
        {polling ? (
          <>
            <StatusDot tone="success" animation="pulse" />
            <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: MONO_FONT }}>
              Polling (15s)
            </span>
            <Button variant="ghost" size="sm" onClick={stopPolling}>
              Stop
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={startPolling}>
            Start
          </Button>
        )}
      </div>

      {unavailable ? (
        <Alert
          tone="warning"
          title="Pod metrics are not available (metrics-server missing or not reachable). Install or repair the Kubernetes metrics server to see CPU and memory use here."
        />
      ) : null}

      <div style={{ display: unavailable ? 'none' : 'block' }}>
        {!sortedContainers.length && !unavailable ? (
          <div
            style={{
              color: 'var(--muted)',
              fontFamily: MONO_FONT,
              fontSize: 12,
              padding: '20px 0',
            }}
          >
            Waiting for first sample…
          </div>
        ) : (
          sortedContainers.map((cName, i) => (
            <MetricsContainerCard
              key={cName}
              cName={cName}
              isPrimary={i === 0}
              hist={aggregated[cName]}
              limits={limitsMap[cName] || { cpuLimit: 0, memLimit: 0 }}
            />
          ))
        )}
      </div>
    </div>
  )
}

function Sparkline({
  points,
  color,
  maxForScale,
}: {
  points: Point[]
  color: string
  maxForScale?: number
}) {
  const W = 260
  const H = 48
  const pad = 2
  if (points.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: 48, display: 'block' }}
      />
    )
  }
  const tMin = points[0].t
  const tMax = points[points.length - 1].t
  const tRange = Math.max(tMax - tMin, 1)
  const vMax = Math.max(maxForScale || 1, ...points.map((p) => p.v), 1)
  const linePts = points
    .map((p) => {
      const x = pad + ((p.t - tMin) / tRange) * (W - pad * 2)
      const y = H - pad - (p.v / vMax) * (H - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const fillPath = `${linePts} ${(W - pad).toFixed(1)},${H} ${pad},${H}`
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: 48, display: 'block' }}
    >
      <polyline points={fillPath} fill={color} stroke="none" opacity="0.08" />
      <polyline
        points={linePts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.8"
      />
    </svg>
  )
}

function MetricsContainerCard({
  cName,
  isPrimary,
  hist,
  limits,
}: {
  cName: string
  isPrimary: boolean
  hist?: History
  limits: { cpuLimit: number; memLimit: number }
}) {
  const cpuPts = [...(hist?.cpu || [])].sort((a, b) => a.t - b.t)
  const memPts = [...(hist?.mem || [])].sort((a, b) => a.t - b.t)
  const latestCpu = cpuPts[cpuPts.length - 1]?.v || 0
  const latestMem = memPts[memPts.length - 1]?.v || 0
  const { cpuLimit, memLimit } = limits

  const cpuPct = pct(latestCpu, cpuLimit)
  const memPct = pct(latestMem, memLimit)
  const cpuColor = cpuLimit ? barColor(cpuPct) : 'var(--accent, #2e90fa)'
  const memColor = memLimit ? barColor(memPct) : 'var(--accent, #2e90fa)'
  const cpuLimitStr = cpuLimit ? ` / ${fmtCpu(cpuLimit)} limit` : ''
  const memLimitStr = memLimit ? ` / ${fmtMem(memLimit)} limit` : ''

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg, 8px)',
        marginBottom: 12,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg)',
        }}
      >
        <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600 }}>
          {cName}
        </span>
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 10,
            color: isPrimary ? 'var(--accent, #2e90fa)' : 'var(--muted)',
          }}
        >
          {isPrimary ? 'primary' : 'sidecar'}
        </span>
        <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: 'var(--muted)' }}>
          {cpuPts.length} samples
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 16,
          padding: 12,
        }}
      >
        <MetricsCell
          label="CPU"
          current={fmtCpu(latestCpu)}
          note={cpuLimit ? cpuPct + '% of limit' : 'no limit set'}
          pctValue={cpuLimit ? cpuPct : null}
          color={cpuColor}
          points={cpuPts}
          maxForScale={cpuLimit || undefined}
          limitStr={cpuLimitStr}
        />
        <MetricsCell
          label="Memory"
          current={fmtMem(latestMem)}
          note={memLimit ? memPct + '% of limit' : 'no limit set'}
          pctValue={memLimit ? memPct : null}
          color={memColor}
          points={memPts}
          maxForScale={memLimit || undefined}
          limitStr={memLimitStr}
        />
      </div>
    </div>
  )
}

function MetricsCell({
  label,
  current,
  note,
  pctValue,
  color,
  points,
  maxForScale,
  limitStr,
}: {
  label: string
  current: string
  note: string
  pctValue: number | null
  color: string
  points: Point[]
  maxForScale?: number
  limitStr: string
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontSize: 16,
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        {current}
        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>
          {note}
        </span>
      </div>
      {pctValue != null ? (
        <div
          style={{
            height: 6,
            borderRadius: 999,
            background: 'var(--badge-bg, #e5e7eb)',
            overflow: 'hidden',
            marginBottom: 6,
          }}
        >
          <div
            style={{
              height: '100%',
              width: pctValue + '%',
              background: color,
              borderRadius: 999,
            }}
          />
        </div>
      ) : null}
      <Sparkline points={points} color={color} maxForScale={maxForScale} />
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        Current{limitStr}
      </div>
    </div>
  )
}
