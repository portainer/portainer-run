import type { Dispatch, SetStateAction } from 'react'

import { Button } from '@ds/v3-components/Button/Button'
import { Input } from '@ds/v3-components/FormField/FormField'

import { MONO_FONT, SECRET_PATTERN } from '../service-detail/detailUi'
import { StepHeading } from './DeployStepUi'
import { HINT_STYLE } from './deployStyles'
import type { EnvVar } from './envExample'

/** Editable list of environment variables parsed from `.env.example`. */
export function SettingsStep({
  envVars,
  setEnvVars,
}: {
  envVars: EnvVar[]
  setEnvVars: Dispatch<SetStateAction<EnvVar[]>>
}) {
  return (
    <div>
      <StepHeading>App settings</StepHeading>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ ...HINT_STYLE, marginBottom: 4 }}>
          Your app needs a few settings — fill in the values below and they will be applied
          securely at deploy time.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {envVars.map((v, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '160px 1fr auto',
                gap: 8,
                alignItems: 'center',
              }}
            >
              {v.custom ? (
                <Input
                  type="text"
                  value={v.key}
                  placeholder="NAME"
                  style={{ fontFamily: MONO_FONT, fontSize: 12 }}
                  onChange={(e) =>
                    setEnvVars((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)),
                    )
                  }
                />
              ) : (
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: 'var(--muted)',
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 5,
                    padding: '7px 10px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {v.key}
                </div>
              )}
              <Input
                type={SECRET_PATTERN.test(v.key) ? 'password' : 'text'}
                value={v.value}
                placeholder={SECRET_PATTERN.test(v.key) ? '••••••••' : 'value'}
                onChange={(e) =>
                  setEnvVars((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                  )
                }
              />
              <Button
                variant="ghost"
                aria-label="Remove variable"
                onClick={() => setEnvVars((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setEnvVars((prev) => [...prev, { key: '', value: '', custom: true }])}
        >
          + Add variable
        </Button>
        <div style={HINT_STYLE}>
          Values whose name looks sensitive (password, token, key, secret, and similar) are
          hidden here, stored in a Kubernetes Secret in your project space, and are never
          written into the git repository. Other values are committed as plain configuration.
        </div>
      </div>
    </div>
  )
}
