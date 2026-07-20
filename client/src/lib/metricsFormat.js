export function parseCpuToMilli(raw) {
  if (!raw) return 0
  if (raw.endsWith('n')) return Math.round(parseInt(raw, 10) / 1e6)
  if (raw.endsWith('u')) return Math.round(parseInt(raw, 10) / 1e3)
  if (raw.endsWith('m')) return parseInt(raw, 10)
  return Math.round(parseFloat(raw) * 1000)
}

export function parseMemToBytes(raw) {
  if (!raw) return 0
  const units = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
  }
  for (const [suffix, mult] of Object.entries(units)) {
    if (raw.endsWith(suffix)) return Math.round(parseFloat(raw) * mult)
  }
  return parseInt(raw, 10) || 0
}

export function fmtCpu(milli) {
  if (milli >= 1000) return (milli / 1000).toFixed(2) + ' cores'
  return milli + 'm'
}

export function fmtMem(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GiB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MiB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KiB'
  return bytes + ' B'
}

export function barColor(p) {
  if (p > 85) return 'var(--red)'
  if (p > 60) return 'var(--amber)'
  return 'var(--green)'
}

export function sparklinePoints(cpuPts) {
  if (cpuPts.length < 2) return ''
  const W = 260
  const H = 48
  const pad = 2
  const tMin = cpuPts[0].t
  const tMax = cpuPts[cpuPts.length - 1].t
  const vMax = Math.max(1, ...cpuPts.map((p) => p.v))
  const toX = (t) => pad + ((t - tMin) / (tMax - tMin + 0.0001)) * (W - pad * 2)
  const toY = (v) => H - pad - (v / vMax) * (H - pad * 2)
  return cpuPts
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'}${toX(p.t).toFixed(1)} ${toY(p.v).toFixed(1)}`,
    )
    .join(' ')
}
