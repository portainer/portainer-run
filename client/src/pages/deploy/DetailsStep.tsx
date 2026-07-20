import type { Dispatch, SetStateAction } from 'react'

import { Alert } from '@ds/v3-components/Alert/Alert'
import { FormControl, Input } from '@ds/v3-components/FormField/FormField'
import { Select } from '@ds/v3-components/Select/Select'

import { MONO_FONT } from '../service-detail/detailUi'
import { LockedValue } from './DeployStepUi'
import { HINT_STYLE } from './deployStyles'

interface EnvOption {
  Id: number | string
  Name: string
}

interface IngressClassOption {
  name: string
  isDefault?: boolean
}

export interface EnvCapabilities {
  ingressOk: boolean | null
  lbOk: boolean | null
  probing: boolean
  ingressClasses: IngressClassOption[]
  defaultIngressClass: string | null
}

interface DeployPerms {
  canDeploy?: boolean
  canCreatePvc?: boolean
}

interface NsHint {
  text: string
  tone: string
}

interface DetailsStepProps {
  availableEnvs: EnvOption[]
  appName: string
  setAppName: Dispatch<SetStateAction<string>>
  envId: string
  setEnvId: Dispatch<SetStateAction<string>>
  nsList: string[]
  setNsList: Dispatch<SetStateAction<string[]>>
  nsLoading: boolean
  manualNs: boolean
  setManualNs: Dispatch<SetStateAction<boolean>>
  manualNsValue: string
  setManualNsValue: Dispatch<SetStateAction<string>>
  namespace: string
  setNamespace: Dispatch<SetStateAction<string>>
  nsHint: NsHint
  setNsHint: Dispatch<SetStateAction<NsHint>>
  nsStatusColor: string
  resolvedNs: string
  perms: DeployPerms | null
  exposeType: string
  setExposeType: Dispatch<SetStateAction<string>>
  envCapabilities: EnvCapabilities
  ingHost: string
  setIngHost: Dispatch<SetStateAction<string>>
  ingClass: string
  setIngClass: Dispatch<SetStateAction<string>>
  ingressHostMap: Record<string, string>
}

/** Third wizard step: app name, target environment/namespace, and exposure. */
export function DetailsStep({
  availableEnvs,
  appName,
  setAppName,
  envId,
  setEnvId,
  nsList,
  setNsList,
  nsLoading,
  manualNs,
  setManualNs,
  manualNsValue,
  setManualNsValue,
  namespace,
  setNamespace,
  nsHint,
  setNsHint,
  nsStatusColor,
  resolvedNs,
  perms,
  exposeType,
  setExposeType,
  envCapabilities,
  ingHost,
  setIngHost,
  ingClass,
  setIngClass,
  ingressHostMap,
}: DetailsStepProps) {
  const singleEnv = availableEnvs.length === 1
  const singleNs = nsList.length === 1 && !nsLoading && !manualNs
  const activeBaseDomain = ingressHostMap[ingClass] || ''

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ maxWidth: 420 }}>
          <FormControl label="App name" hint="Lowercase, alphanumeric and hyphens">
            <Input
              type="text"
              value={appName}
              onChange={(e) =>
                setAppName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
              }
              placeholder="my-app"
            />
          </FormControl>
        </div>

        {/* When the user has exactly one environment and one project space,
            there is nothing to choose. Hide the infrastructure selectors
            entirely — non-technical users should not have to reason about
            environments or namespaces (per user feedback). The values are
            auto-selected elsewhere, so deploy still has everything it needs. */}
        {singleEnv && singleNs ? (
          <div style={{ ...HINT_STYLE, marginBottom: 4 }}>
            Deploying to <strong style={{ color: 'var(--text)' }}>{availableEnvs[0].Name}</strong>
            {' / '}
            <strong style={{ color: 'var(--text)' }}>{nsList[0]}</strong>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <FormControl label="Deployment target" hint="Portainer environment to deploy into">
                {availableEnvs.length === 1 ? (
                  <LockedValue>{availableEnvs[0].Name}</LockedValue>
                ) : (
                  <Select
                    value={envId}
                    onChange={(e) => {
                      setEnvId(e.target.value)
                      setNamespace('')
                      setNsList([])
                      setManualNs(false)
                      setNsHint({ text: '', tone: 'dim' })
                    }}
                    options={[
                      { value: '', label: '— Select —' },
                      ...availableEnvs.map((e) => ({
                        value: String(e.Id),
                        label: e.Name,
                      })),
                    ]}
                  />
                )}
              </FormControl>
            </div>
            <div style={{ flex: 1 }}>
              <FormControl
                label="Project space"
                hint="Project space must already exist in the target"
              >
                <div>
                  {!manualNs ? (
                    nsList.length === 1 && !nsLoading ? (
                      <LockedValue>{nsList[0]}</LockedValue>
                    ) : (
                      <Select
                        value={namespace}
                        onChange={(e) => setNamespace(e.target.value)}
                        disabled={!envId || nsLoading}
                        options={[
                          {
                            value: '',
                            label: !envId
                              ? 'Select target first...'
                              : nsLoading
                                ? 'Loading project spaces...'
                                : '— Select —',
                          },
                          ...nsList.map((n) => ({ value: n, label: n })),
                        ]}
                      />
                    )
                  ) : (
                    <Input
                      type="text"
                      value={manualNsValue}
                      onChange={(e) => setManualNsValue(e.target.value)}
                      placeholder="my-project-space"
                    />
                  )}
                  {nsHint.text && (
                    <div
                      style={{
                        fontFamily: MONO_FONT,
                        fontSize: 12,
                        color: nsStatusColor,
                        marginTop: 4,
                      }}
                    >
                      {nsHint.text}
                    </div>
                  )}
                </div>
              </FormControl>
            </div>
          </div>
        )}

        {perms && (!perms.canDeploy || !perms.canCreatePvc) && (
          <Alert
            tone="danger"
            title={
              <>
                {!perms.canDeploy && (
                  <div>
                    No permission to create Deployments in project space &quot;{resolvedNs}
                    &quot;.
                  </div>
                )}
                {!perms.canCreatePvc && (
                  <div>
                    No permission to create PersistentVolumeClaims in project space &quot;
                    {resolvedNs}&quot;.
                  </div>
                )}
              </>
            }
            description="Select a different project space or contact your platform administrator."
          />
        )}

        <div style={{ maxWidth: 420 }}>
          <FormControl label="Expose as">
            <div>
              <Select
                value={exposeType}
                onChange={(e) => setExposeType(e.target.value)}
                disabled={envCapabilities.probing}
                options={[
                  {
                    value: 'NodePort',
                    label: 'Network Accessible - Default, use this unless advised otherwise',
                  },
                  ...(envCapabilities.probing || envCapabilities.lbOk !== false
                    ? [{ value: 'LoadBalancer', label: 'Network Accessible via dedicated IP' }]
                    : []),
                  ...(envCapabilities.probing || envCapabilities.ingressOk !== false
                    ? [{ value: 'Ingress', label: 'Network Accessible via a URL' }]
                    : []),
                ]}
              />
              {!envCapabilities.probing &&
                envId &&
                (envCapabilities.lbOk === false || envCapabilities.ingressOk === false) && (
                  <div style={{ ...HINT_STYLE, marginTop: 4 }}>
                    {[
                      envCapabilities.lbOk === false && 'LoadBalancer',
                      envCapabilities.ingressOk === false && 'Ingress',
                    ]
                      .filter(Boolean)
                      .join(' and ')}{' '}
                    not detected on this cluster — option
                    {envCapabilities.lbOk === false && envCapabilities.ingressOk === false
                      ? 's'
                      : ''}{' '}
                    hidden
                  </div>
                )}
            </div>
          </FormControl>
        </div>

        {exposeType === 'Ingress' && (
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <FormControl label="Hostname">
                {activeBaseDomain ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                    <Input
                      type="text"
                      value={appName}
                      onChange={(e) =>
                        setAppName(e.target.value.replace(/[^a-z0-9-]/gi, '-').toLowerCase())
                      }
                      style={{
                        borderRadius: '6px 0 0 6px',
                        borderRight: 'none',
                        flex: '0 0 auto',
                        width: 140,
                      }}
                    />
                    <span
                      style={{
                        padding: '8px 12px',
                        background: 'var(--bg)',
                        border: '1px solid var(--border)',
                        borderRadius: '0 6px 6px 0',
                        fontFamily: MONO_FONT,
                        fontSize: 13,
                        color: 'var(--muted)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      .{activeBaseDomain}
                    </span>
                  </div>
                ) : (
                  <Input
                    type="text"
                    value={ingHost}
                    onChange={(e) => setIngHost(e.target.value)}
                    placeholder="app.example.com"
                  />
                )}
              </FormControl>
            </div>
            <div style={{ flex: 1 }}>
              <FormControl label="Ingress class">
                {envCapabilities.ingressClasses.length > 1 ? (
                  <Select
                    value={ingClass}
                    onChange={(e) => setIngClass(e.target.value)}
                    options={envCapabilities.ingressClasses.map((c) => ({
                      value: c.name,
                      label: `${c.name}${c.isDefault ? ' (default)' : ''}`,
                    }))}
                  />
                ) : (
                  <Input
                    type="text"
                    value={ingClass}
                    onChange={(e) => setIngClass(e.target.value)}
                    placeholder="nginx"
                    readOnly={envCapabilities.ingressClasses.length === 1}
                    style={
                      envCapabilities.ingressClasses.length === 1
                        ? { opacity: 0.6, cursor: 'default' }
                        : {}
                    }
                  />
                )}
              </FormControl>
            </div>
          </div>
        )}

        {(!appName || !envId || !resolvedNs) && (
          <div
            style={{
              textAlign: 'right',
              fontSize: 12,
              color: 'var(--status-warning, #f79009)',
            }}
          >
            {[
              !appName && 'Enter an app name',
              !envId && 'Select a deployment target',
              !resolvedNs && 'Select a project space',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
      </div>
    </div>
  )
}
