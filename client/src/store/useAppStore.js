import { create } from 'zustand'

const initialCache = {
  deployments: [],
  lastFetch: null,
  fetching: false,
  everLoaded: false,
}

export const useAppStore = create((set, get) => ({
  token: '',
  /** Shown in connect; sent as X-Portainer-URL when set (or override server .env) */
  portainerBaseUrl: '',
  /** True when the API server was started with PORTAINER_URL in the environment. */
  portainerFromServer: false,
  serverLabel: 'Loading...',
  environments: [],
  isAdmin: false,
  isAiAvailable: false,
  aiProvider: 'anthropic',
  baseDomain: '',
  /** @type {Record<string, { reason?: string, disabledAt?: string }>} */
  disabledEnvs: {},
  cache: { ...initialCache },
  cacheStatus: 'loading' /** 'loading' | 'cached' | 'fresh' | 'stale' */,

  connected: false,
  authChecking: false,
  connectError: '',

  // Aggregated /env-status/{id} for rows
  /** @type {Record<string, { rv: string, data: Record<string, { statusReason?: string, accessUrl?: string|null, accessLabel?: string|null }> }>} */
  envStatusClientCache: {},

  /** @type {Record<string, { canDeploy: boolean, canEdit: boolean, canDelete: boolean, canRestart: boolean, canViewLogs: boolean }>} */
  envPermissions: {},

  /** @type {null | { envId: string, ns: string, name: string }} */
  deleteTarget: null,

  chatOpen: false,
  toasts: [],

  // Deploy wizard / catalogue — minimal global flags
  catalogue: null,
  templatesLoading: false,

  setToken: (token) => set({ token }),
  setPortainerBaseUrl: (portainerBaseUrl) => set({ portainerBaseUrl: portainerBaseUrl || '' }),
  setPortainerFromServer: (v) => set({ portainerFromServer: Boolean(v) }),
  setServerLabel: (serverLabel) => set({ serverLabel }),
  setEnvironments: (environments) => set({ environments }),
  setIsAdmin: (v) => set({ isAdmin: v }),
  setAi: (isAiAvailable, aiProvider, baseDomain) =>
    set({ isAiAvailable, aiProvider, baseDomain: baseDomain || '' }),
  setDisabledEnvs: (disabledEnvs) => set({ disabledEnvs }),
  setCache: (updater) =>
    set((s) => (typeof updater === 'function' ? { cache: updater(s.cache) } : { cache: updater })),
  setCacheField: (patch) => set((s) => ({ cache: { ...s.cache, ...patch } })),
  setCacheStatus: (cacheStatus) => set({ cacheStatus }),
  setConnected: (connected) => set({ connected }),
  setAuthChecking: (authChecking) => set({ authChecking }),
  setConnectError: (connectError) => set({ connectError }),
  setEnvStatusClientCache: (envStatusClientCache) => set({ envStatusClientCache }),
  patchEnvStatus: (envId, rv, data) =>
    set((s) => ({
      envStatusClientCache: {
        ...s.envStatusClientCache,
        [String(envId)]: { rv, data },
      },
    })),

  setEnvPermissions: (envPermissions) => set({ envPermissions }),
  patchEnvPermissions: (envId, namespace, perms) =>
    set((s) => ({ envPermissions: { ...s.envPermissions, [`${envId}:${namespace}`]: perms } })),
  setDeleteTarget: (deleteTarget) => set({ deleteTarget }),
  setChatOpen: (chatOpen) => {
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('chat-open', chatOpen)
    }
    return set({ chatOpen })
  },
  pushToast: (msg, type = 'info', id) => {
    const tid = id ?? `t-${Date.now()}-${Math.random().toString(16).slice(2)}`
    set((s) => ({ toasts: [...s.toasts, { id: tid, msg, type }] }))
    setTimeout(() => useAppStore.getState().removeToast(tid), 4000)
    return tid
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  reset: () =>
    set((s) => ({
      token: '',
      // Keep Portainer URL so the connect form still shows the last used instance
      portainerBaseUrl: s.portainerBaseUrl,
      portainerFromServer: s.portainerFromServer,
      serverLabel: 'Loading...',
      environments: [],
      isAdmin: false,
      isAiAvailable: false,
      disabledEnvs: {},
      cache: { ...initialCache },
      cacheStatus: 'loading',
      connected: false,
      authChecking: false,
      connectError: '',
      deleteTarget: null,
      chatOpen: false,
      envStatusClientCache: {},
      envPermissions: {},
      toasts: [],
    })),
}))

export function visibleEnvironments(s) {
  return s.environments.filter((e) => !s.disabledEnvs?.[String(e.Id)])
}

/** Deployments in visible environments only (mirrors old app: workloads respect disabled / hidden envs). */
export function visibleDeployments(s) {
  const vis = new Set(visibleEnvironments(s).map((e) => String(e.Id)))
  return s.cache.deployments.filter((d) => vis.has(String(d._envId)))
}

export function isEnvDisabled(s, envId) {
  return Boolean(s.disabledEnvs?.[String(envId)])
}
