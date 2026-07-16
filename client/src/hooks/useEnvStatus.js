import { useEffect } from 'react'
import { useAppStore, visibleEnvironments } from '../store/useAppStore.js'
import { serverFetch } from '../lib/api.js'
import { inflightDedupe } from '../lib/inflightDedupe.js'

function makeLimiter(n) {
  let active = 0
  const queue = []
  return function run(fn) {
    return new Promise((resolve, reject) => {
      const next = () => {
        if (!queue.length) return
        if (active >= n) return
        active++
        const { fn: f, resolve: res, reject: rej } = queue.shift()
        Promise.resolve()
          .then(f)
          .then((v) => {
            active--
            res(v)
            next()
          })
          .catch((e) => {
            active--
            rej(e)
            next()
          })
      }
      queue.push({ fn, resolve, reject })
      next()
    })
  }
}

const limit = makeLimiter(5)

function rvFingerprint(deps, state) {
  const venv = new Set(visibleEnvironments(state).map((e) => String(e.Id)))
  const by = {}
  for (const d of deps) {
    const envId = d._envId
    if (!venv.has(String(envId))) continue
    if (!by[envId]) by[envId] = { rvs: [], namespaces: new Set() }
    by[envId].rvs.push(d.metadata?.resourceVersion || '')
    if (d.metadata?.namespace) by[envId].namespaces.add(d.metadata.namespace)
  }
  const out = {}
  for (const [envId, { rvs, namespaces }] of Object.entries(by)) {
    out[envId] = { rv: rvs.sort().join(','), namespaces: [...namespaces].sort() }
  }
  return out
}

export function useEnvStatusOnDeployments(deps, token) {
  const patchEnvStatus = useAppStore((s) => s.patchEnvStatus)

  useEffect(() => {
    if (!token) return
    const state = useAppStore.getState()
    const finger = rvFingerprint(deps, state)
    for (const [envId, { rv, namespaces }] of Object.entries(finger)) {
      const nsParam = namespaces.length ? '?ns=' + namespaces.join(',') : ''
      const job = () =>
        inflightDedupe(`env-status:${envId}`, async () => {
          const r = await serverFetch(`/env-status/${envId}${nsParam}`)
          return r.ok ? r.json() : null
        })
          .then((json) => {
            if (json && json.data) {
              patchEnvStatus(envId, rv, json.data)
            }
          })
          .catch(() => {})
      void limit(job)
    }
  }, [deps, token, patchEnvStatus])
}

export function getExtraForApp(envStatusClientCache, envId, name) {
  const block = envStatusClientCache[String(envId)]
  if (!block?.data) return { reason: '', accessUrl: null, accessLabel: null }
  const r = block.data[name]
  if (!r) return { reason: '', accessUrl: null, accessLabel: null }
  return {
    reason: r.statusReason || '',
    accessUrl: r.accessUrl,
    accessLabel: r.accessLabel,
  }
}
