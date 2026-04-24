import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { kubeFetch } from '../../lib/api.js'
import { useAppStore } from '../../store/useAppStore.js'
import {
  barColor,
  fmtCpu,
  fmtMem,
  parseCpuToMilli,
  parseMemToBytes,
  pct,
} from '../../lib/k8sMetrics.js'

/**
 * @param {object} props
 * @param {object} props.d deployment
 * @param {string} props.envId
 * @param {string} props.namespace
 * @param {string} props.name app / deployment name
 */
export default function ServiceDetailMetricsTab({ d, envId, namespace, name }) {
  const token = useAppStore((s) => s.token)
  /** @type {React.MutableRefObject<Record<string, Record<string, { cpu: {t:number,v:number}[], mem: {t:number,v:number}[] }>>>} */
  const historyRef = useRef({})
  const [tick, setTick] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const [polling, setPolling] = useState(true)
  const timerRef = useRef(/** @type {ReturnType<typeof setInterval> | null} */ (null))

  const bump = useCallback(() => setTick((t) => t + 1), [])

  const fetchSample = useCallback(async () => {
    if (!token || !envId || !namespace || !name) return
    try {
      const r = await kubeFetch(
        token,
        envId,
        `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`,
      )
      if (r.status === 404 || r.status === 503) {
        setUnavailable(true)
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
        setPolling(false)
        return
      }
      if (!r.ok) return

      const data = await r.json()
      const now = Date.now()
      const cutoff = now - 10 * 60 * 1000
      const hist = historyRef.current

      const pods = (data.items || []).filter(
        (p) =>
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
    const m = {}
    for (const cs of containerSpecs) {
      m[cs.name] = {
        cpuLimit: parseCpuToMilli(cs.resources?.limits?.cpu || ''),
        memLimit: parseMemToBytes(cs.resources?.limits?.memory || ''),
      }
    }
    return m
  }, [containerSpecs])

  const aggregated = useMemo(() => {
    const out = /** @type {Record<string, { cpu: {t:number,v:number}[], mem: {t:number,v:number}[] }>} */ ({})
    for (const podHistory of Object.values(historyRef.current)) {
      for (const [cName, h] of Object.entries(podHistory)) {
        if (!out[cName]) out[cName] = { cpu: [], mem: [] }
        h.cpu.forEach((p) => out[cName].cpu.push(p))
        h.mem.forEach((p) => out[cName].mem.push(p))
      }
    }
    return out
  }, [tick])

  const containerOrder = containerSpecs.map((cs) => cs.name)
  const sortedContainers = useMemo(() => {
    const keys = Object.keys(aggregated)
    return [
      ...containerOrder.filter((n) => keys.includes(n)),
      ...keys.filter((n) => !containerOrder.includes(n)),
    ]
  }, [aggregated, containerOrder])

  return (
    <div>
      <div
        className="log-toolbar"
        style={{ marginBottom: 12, justifyContent: 'flex-start' }}
      >
        {polling ? (
          <>
            <span className="live-dot" style={{ display: 'block' }} />
            <span style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
              Polling (15s)
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={stopPolling}>
              Stop
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={startPolling}>
            Start
          </button>
        )}
      </div>

      {unavailable ? (
        <div className="ai-unavail" style={{ display: 'flex' }}>
          <span>
            Pod metrics are not available (metrics-server missing or not reachable). Install or
            repair the Kubernetes metrics server to see CPU and memory use here.
          </span>
        </div>
      ) : null}

      <div
        className="metricsGrid"
        style={{ display: unavailable ? 'none' : 'block' }}
      >
        {!sortedContainers.length && !unavailable ? (
          <div
            style={{
              color: 'var(--text-dim)',
              fontFamily: 'var(--mono)',
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

function Sparkline({ points, color, maxForScale }) {
  const W = 260
  const H = 48
  const pad = 2
  if (points.length < 2) {
    return <svg className="metrics-sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" />
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
      className="metrics-sparkline"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
    >
      <polyline
        points={fillPath}
        fill={color}
        stroke="none"
        opacity="0.08"
      />
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

function MetricsContainerCard({ cName, isPrimary, hist, limits }) {
  const cpuPts = [...(hist?.cpu || [])].sort((a, b) => a.t - b.t)
  const memPts = [...(hist?.mem || [])].sort((a, b) => a.t - b.t)
  const latestCpu = cpuPts[cpuPts.length - 1]?.v || 0
  const latestMem = memPts[memPts.length - 1]?.v || 0
  const { cpuLimit, memLimit } = limits

  const cpuPct = pct(latestCpu, cpuLimit)
  const memPct = pct(latestMem, memLimit)
  const cpuColor = cpuLimit ? barColor(cpuPct) : 'var(--accent)'
  const memColor = memLimit ? barColor(memPct) : 'var(--accent)'
  const cpuLimitStr = cpuLimit ? ` / ${fmtCpu(cpuLimit)} limit` : ''
  const memLimitStr = memLimit ? ` / ${fmtMem(memLimit)} limit` : ''

  return (
    <div className="metrics-container-card">
      <div className="metrics-container-head">
        <span className="metrics-container-name">{cName}</span>
        {isPrimary ? (
          <span className="cprimary">primary</span>
        ) : (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--text-dim)',
            }}
          >
            sidecar
          </span>
        )}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
          {cpuPts.length} samples
        </span>
      </div>
      <div className="metrics-row">
        <div className="metrics-cell">
          <div className="metrics-label">CPU</div>
          <div className="metrics-current">
            {fmtCpu(latestCpu)}
            <span>
              {cpuLimit ? cpuPct + '% of limit' : 'no limit set'}
            </span>
          </div>
          {cpuLimit ? (
            <div className="metrics-bar-wrap">
              <div
                className="metrics-bar"
                style={{ width: cpuPct + '%', background: cpuColor }}
              />
            </div>
          ) : null}
          <Sparkline points={cpuPts} color={cpuColor} maxForScale={cpuLimit || undefined} />
          <div className="metrics-limit">Current{cpuLimitStr}</div>
        </div>
        <div className="metrics-cell">
          <div className="metrics-label">Memory</div>
          <div className="metrics-current">
            {fmtMem(latestMem)}
            <span>
              {memLimit ? memPct + '% of limit' : 'no limit set'}
            </span>
          </div>
          {memLimit ? (
            <div className="metrics-bar-wrap">
              <div
                className="metrics-bar"
                style={{ width: memPct + '%', background: memColor }}
              />
            </div>
          ) : null}
          <Sparkline points={memPts} color={memColor} maxForScale={memLimit || undefined} />
          <div className="metrics-limit">Current{memLimitStr}</div>
        </div>
      </div>
    </div>
  )
}
