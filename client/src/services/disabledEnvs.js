import { kubeFetch } from '../lib/api.js'
import { useAppStore } from '../store/useAppStore.js'

const CM_NAME = 'portainer-run-config'

export async function loadDisabledEnvs(token, environments) {
  const st = useAppStore.getState
  const CM_NS = st().configNamespace
  for (const env of environments) {
    try {
      const r = await kubeFetch(token, env.Id, `/api/v1/namespaces/${CM_NS}/configmaps/${CM_NAME}`)
      if (r.status === 404) {
        st().setDisabledEnvs({})
        return
      }
      if (!r.ok) continue
      const cm = await r.json()
      const raw = cm.data?.disabledEnvs
      if (!raw) {
        st().setDisabledEnvs({})
        return
      }
      const parsed = JSON.parse(raw)
      const normalized = {}
      for (const [k, v] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
        normalized[String(k)] = v
      }
      st().setDisabledEnvs(normalized)
      return
    } catch {
      continue
    }
  }
  st().setDisabledEnvs({})
}

export async function saveDisabledEnvs(token, environments, disabledEnvs) {
  const CM_NS = useAppStore.getState().configNamespace
  const payload = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: CM_NAME,
      namespace: CM_NS,
      labels: { 'managed-by': 'portainer-run' },
    },
    data: { disabledEnvs: JSON.stringify(disabledEnvs) },
  }
  for (const env of environments) {
    try {
      const patch = await kubeFetch(
        token,
        env.Id,
        `/api/v1/namespaces/${CM_NS}/configmaps/${CM_NAME}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
          body: JSON.stringify(payload),
        },
      )
      if (patch.status === 404) {
        await kubeFetch(token, env.Id, `/api/v1/namespaces/${CM_NS}/configmaps`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        return
      }
      if (patch.ok) return
    } catch {
      continue
    }
  }
}
