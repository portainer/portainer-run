import { kubeFetch } from '../api.js'

/**
 * @param {string} token
 * @param {object} dep — deployment from cache (has _envId, metadata, status, spec)
 * @param {{ logTailLines?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function gatherServiceDiagnostics(token, dep, opts = {}) {
  const logTail = typeof opts.logTailLines === 'number' ? opts.logTailLines : 100
  const dName = dep.metadata.name
  const dNs = dep.metadata.namespace
  const dEnvId = dep._envId
  const labelSel = `app=${dName}`

  let podsR
  try {
    podsR = await kubeFetch(
      token,
      dEnvId,
      `/api/v1/namespaces/${dNs}/pods?labelSelector=${encodeURIComponent(labelSel)}`,
    )
  } catch {
    return ''
  }
  if (!podsR.ok) return ''

  let pods
  try {
    const j = await podsR.json()
    pods = j.items || []
  } catch {
    return ''
  }
  if (!pods.length) return ''

  const [logChunks, condChunks, eventChunks] = await Promise.all([
    Promise.all(
      pods.flatMap((pod) =>
        (pod.spec?.containers || []).map(async (ct) => {
          try {
            const r = await kubeFetch(
              token,
              dEnvId,
              `/api/v1/namespaces/${dNs}/pods/${pod.metadata.name}/log?tailLines=${logTail}&container=${encodeURIComponent(ct.name)}`,
            )
            return `=== Logs: ${pod.metadata.name}/${ct.name} ===\n${
              r.ok ? (await r.text()) || '[no output]' : '[unavailable]'
            }`
          } catch {
            return ''
          }
        }),
      ),
    ),
    Promise.resolve(
      pods.map((pod) => {
        const lines = [`=== Pod: ${pod.metadata.name} (${pod.status?.phase || '?'}) ===`]
        for (const c of pod.status?.conditions || []) {
          lines.push(
            `  ${c.type}: ${c.status}${c.reason ? ' (' + c.reason + ')' : ''}${
              c.message ? ' - ' + c.message : ''
            }`,
          )
        }
        for (const cs of pod.status?.containerStatuses || []) {
          lines.push(
            `  Container ${cs.name}: ready=${cs.ready}, restarts=${cs.restartCount}`,
          )
          if (cs.state?.waiting) {
            lines.push(
              `    Waiting: ${cs.state.waiting.reason || ''} ${cs.state.waiting.message || ''}`,
            )
          }
        }
        return lines.join('\n')
      }),
    ),
    Promise.all([
      kubeFetch(
        token,
        dEnvId,
        `/api/v1/namespaces/${dNs}/events?fieldSelector=${encodeURIComponent('involvedObject.name=' + dName)}`,
      )
        .then(async (r) => {
          if (!r.ok) return ''
          try {
            const j = await r.json()
            const evts = (j.items || []).sort(
              (a, b) =>
                new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0),
            )
            return evts.length
              ? '=== Events ===\n' + evts.slice(0, 10).map((e) => `  [${e.type}] ${e.reason}: ${e.message}`).join('\n')
              : ''
          } catch {
            return ''
          }
        })
        .catch(() => ''),
      ...pods.map((pod) =>
        kubeFetch(
          token,
          dEnvId,
          `/api/v1/namespaces/${dNs}/events?fieldSelector=${encodeURIComponent('involvedObject.name=' + pod.metadata.name)}`,
        )
          .then(async (r) => {
            if (!r.ok) return ''
            try {
              const j = await r.json()
              const evts = (j.items || []).sort(
                (a, b) =>
                  new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0),
              )
              return evts.length
                ? `=== Pod Events: ${pod.metadata.name} ===\n` +
                    evts.slice(0, 5).map((e) => `  [${e.type}] ${e.reason}: ${e.message}`).join('\n')
                : ''
            } catch {
              return ''
            }
          })
          .catch(() => ''),
      ),
    ]),
  ])

  const allDiag = [...condChunks, ...eventChunks, ...logChunks].filter(Boolean).join('\n\n')
  if (!allDiag.trim()) return ''
  return (
    '\n\nLIVE DIAGNOSTIC DATA for ' +
    dName +
    ':\n' +
    (allDiag.length > 30000 ? allDiag.slice(-30000) : allDiag)
  )
}
