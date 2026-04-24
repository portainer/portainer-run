import { kubeFetch } from './api.js'

/**
 * @param {string} token
 * @param {object} env Portainer environment { Id, Name }
 * @returns {Promise<object[]>}
 */
export async function fetchEnvDeployments(token, env) {
  try {
    const nsR = await kubeFetch(token, env.Id, '/api/v1/namespaces')
    if (!nsR.ok) return []
    const nss = (await nsR.json()).items.map((n) => n.metadata.name)
    const results = await Promise.all(
      nss.map(async (ns) => {
        try {
          let r = await kubeFetch(
            token,
            env.Id,
            `/apis/apps/v1/namespaces/${ns}/deployments?labelSelector=${encodeURIComponent('managed-by=portainer-run')}`,
          )
          if (!r.ok) return []
          const data = await r.json()
          let items = data.items || []
          if (!items.length) {
            const r2 = await kubeFetch(
              token,
              env.Id,
              `/apis/apps/v1/namespaces/${ns}/deployments`,
            )
            if (r2.ok) {
              const data2 = await r2.json()
              items = (data2.items || []).filter(
                (d) => d.metadata?.labels?.['managed-by'] === 'portainer-run',
              )
            }
          }
          items.forEach((d) => {
            d._envId = env.Id
            d._envName = env.Name
          })
          return items
        } catch {
          return []
        }
      }),
    )
    return results.flat()
  } catch {
    return []
  }
}
