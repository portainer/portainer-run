export function parseCpuToMilli(raw) {
  if (!raw) return 0
  const s = String(raw)
  if (s.endsWith('n')) return Math.round(parseInt(s, 10) / 1e6)
  if (s.endsWith('u')) return Math.round(parseInt(s, 10) / 1e3)
  if (s.endsWith('m')) return parseInt(s, 10)
  return Math.round(parseFloat(s) * 1000)
}

export function parseMemToBytes(raw) {
  if (!raw) return 0
  const s = String(raw)
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
    if (s.endsWith(suffix)) return Math.round(parseFloat(s) * mult)
  }
  return parseInt(s, 10) || 0
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

export function pct(val, limit) {
  if (!limit) return 0
  return Math.min(100, Math.round((val / limit) * 100))
}

export function barColor(p) {
  if (p > 85) return 'var(--red)'
  if (p > 60) return 'var(--amber)'
  return 'var(--green)'
}
