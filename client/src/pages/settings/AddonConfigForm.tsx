import { useEffect, useRef, useState } from 'react'

import { Alert } from '@ds/v3-components/Alert/Alert'
import { Button } from '@ds/v3-components/Button/Button'
import { Card } from '@ds/v3-components/Card/Card'
import { FormControl, Input } from '@ds/v3-components/FormField/FormField'
import { Skeleton } from '@ds/v3-components/Skeleton/Skeleton'

import {
  ENCRYPTION_KEY_ENTRY,
  SETTINGS,
  canGenerateSecrets,
  deleteConfigEntry,
  reloadSettings,
  entryIsSet,
  generateEncryptionKey,
  listConfig,
  patchConfigEntry,
  putConfig,
  readServerConfig,
  waitForRestart,
  type ConfigEntry,
  type ConfigEntryInput,
  type SettingDef,
} from '../../lib/addonConfig'
import { errMessage } from '../../lib/errors'
import { MONO_FONT } from '../service-detail/detailUi'

const HINT_STYLE: React.CSSProperties = { fontSize: 12, color: 'var(--muted)' }
const MONO_INPUT: React.CSSProperties = { fontFamily: MONO_FONT, fontSize: 12 }

/** Placeholder shown for a sensitive value Portainer holds but will not return. */
const MASKED = '••••••••••••••••'

export type SavePhase = 'idle' | 'saving' | 'applying' | 'done' | 'timeout'

interface FieldState {
  /** What the user typed. Empty means "leave whatever is stored alone". */
  draft: string
  /** Portainer already holds a value for this key. */
  isSet: boolean
}

function initialFields(entries: ConfigEntry[]): Record<string, FieldState> {
  const out: Record<string, FieldState> = {}
  for (const def of SETTINGS) {
    const entry = entries.find((e) => e.key === def.key)
    out[def.key] = {
      // Plain values come back in full; sensitive ones stay blank until retyped.
      draft: def.sensitive ? '' : (entry?.value ?? ''),
      isSet: entryIsSet(entry),
    }
  }
  return out
}

export function AddonConfigForm({
  /** Restrict the form to the settings that must exist before the app works. */
  requiredOnly = false,
  submitLabel = 'Save',
  onSaved,
}: {
  requiredOnly?: boolean
  submitLabel?: string
  onSaved?: (phase: 'restarted' | 'timeout' | 'unknown') => void
}) {
  const visible = requiredOnly ? SETTINGS.filter((s) => s.required) : SETTINGS

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [fields, setFields] = useState<Record<string, FieldState>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveError, setSaveError] = useState('')
  const [phase, setPhase] = useState<SavePhase>('idle')
  // What Portainer had at load: distinguishes a real edit from an untouched
  // field, and an initial PUT from per-key PATCHes.
  const preserved = useRef<ConfigEntry[]>([])

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setLoadError('')
    try {
      const entries = await listConfig()
      preserved.current = entries
      setFields(initialFields(entries))
    } catch (e) {
      setLoadError(errMessage(e) || 'Could not load configuration.')
      setFields(initialFields([]))
    } finally {
      setLoading(false)
    }
  }

  function set(key: string, value: string) {
    setFields((f) => ({ ...f, [key]: { ...f[key], draft: value } }))
    setErrors((e) => ({ ...e, [key]: '' }))
    setSaveError('')
  }

  function handleGenerate(def: SettingDef) {
    if (def.key !== ENCRYPTION_KEY_ENTRY) return
    set(def.key, generateEncryptionKey())
  }

  /** Fill blank required secrets so setup is one click. Never overwrites. */
  function withGeneratedDefaults(
    current: Record<string, FieldState>,
  ): Record<string, FieldState> {
    let next = current
    for (const def of visible) {
      if (!def.generated || !def.required) continue
      const state = next[def.key]
      if (state?.draft?.trim() || state?.isSet) continue
      if (!canGenerateSecrets()) continue
      next = {
        ...next,
        [def.key]: { ...state, draft: generateEncryptionKey() },
      }
    }
    return next
  }

  function validate(snapshot: Record<string, FieldState>): boolean {
    const next: Record<string, string> = {}
    for (const def of visible) {
      const state = snapshot[def.key]
      const draft = state?.draft?.trim() ?? ''
      if (!draft) {
        // Blank keeps what is stored; only a problem when nothing is.
        if (def.required && !state?.isSet) {
          next[def.key] = `${def.label} is required.`
        }
        continue
      }
      const err = def.validate?.(draft)
      if (err) next[def.key] = err
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  /**
   * What changed. Blank sensitive means "keep stored" — Portainer never returns
   * secrets. Blank non-sensitive whose value we received is a real deletion.
   */
  function diff(snapshot: Record<string, FieldState>): {
    changed: ConfigEntryInput[]
    cleared: string[]
  } {
    const changed: ConfigEntryInput[] = []
    const cleared: string[] = []

    for (const def of visible) {
      const state = snapshot[def.key]
      const draft = state?.draft?.trim() ?? ''

      if (draft) {
        const stored = preserved.current.find((e) => e.key === def.key)
        // Re-saving an unchanged plaintext value would roll the pod for nothing.
        if (!def.sensitive && stored?.value === draft) continue
        changed.push({ key: def.key, value: draft, sensitive: def.sensitive })
      } else if (!def.sensitive && state?.isSet) {
        cleared.push(def.key)
      }
    }

    return { changed, cleared }
  }

  /** True when Portainer holds nothing yet, so a full PUT cannot lose anything. */
  function isFirstWrite(): boolean {
    return preserved.current.length === 0
  }

  async function handleSave() {
    // One synchronous snapshot: setState is not visible to validate/diff here.
    const effective = withGeneratedDefaults(fields)
    if (effective !== fields) setFields(effective)

    if (!validate(effective)) return

    const { changed, cleared } = diff(effective)
    if (!changed.length && !cleared.length) {
      setSaveError('No changes to save.')
      return
    }

    setSaveError('')
    setPhase('saving')

    const before = await readServerConfig()

    try {
      if (isFirstWrite()) {
        // Nothing stored yet, so one atomic PUT cannot lose anything.
        await putConfig(changed)
      } else {
        // A full PUT would have to re-send secrets Portainer will not hand
        // back, wiping any the user did not retype. Touch only what moved.
        for (const entry of changed) await patchConfigEntry(entry)
        for (const key of cleared) await deleteConfigEntry(key)
      }
    } catch (e) {
      setSaveError(errMessage(e) || 'Save failed.')
      setPhase('idle')
      return
    }

    // Settings are memory-only and nothing pushes them, so ask for a re-read.
    setPhase('applying')
    let live = false
    try {
      live = await reloadSettings()
    } catch {
      // Saved either way; fall back to watching for a restart.
      live = (await waitForRestart(before?.bootId)) === 'restarted'
    }
    setPhase(live ? 'done' : 'timeout')
    onSaved?.(live ? 'restarted' : 'timeout')
  }

  if (loading) {
    return (
      <Card style={{ maxWidth: 640 }}>
        <div
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <Skeleton height={54} radius={8} />
          <Skeleton height={54} radius={8} />
        </div>
      </Card>
    )
  }

  const busy = phase === 'saving' || phase === 'applying'
  // A failed load leaves us blind to what Portainer holds, so writing could
  // overwrite a key we never saw. Require a clean read first.
  const blocked = Boolean(loadError)

  return (
    <Card style={{ maxWidth: 640 }}>
      <div
        style={{
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {loadError && (
          <Alert
            tone="danger"
            title="Could not load your settings"
            description={loadError}
            action={
              <Button variant="ghost" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        )}

        {visible.map((def) => {
          const state = fields[def.key] ?? { draft: '', isSet: false }
          // Changing this destroys data encrypted under the old value, so
          // rotation is not a settings-form operation.
          const locked = Boolean(def.immutableOnceSet && state.isSet)
          return (
            <div
              key={def.key}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <FormControl label={def.label}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Input
                    type={def.sensitive ? 'password' : 'text'}
                    value={state.draft}
                    onChange={(e) => set(def.key, e.target.value)}
                    placeholder={
                      state.isSet && def.sensitive
                        ? MASKED
                        : (def.placeholder ?? '')
                    }
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...MONO_INPUT, flex: 1 }}
                    disabled={busy || locked || blocked}
                  />
                  {def.generated && canGenerateSecrets() && !locked && (
                    <Button
                      variant="ghost"
                      onClick={() => handleGenerate(def)}
                      disabled={busy || blocked}
                    >
                      Generate
                    </Button>
                  )}
                </div>
              </FormControl>
              <div style={HINT_STYLE}>{def.help}</div>
              {locked ? (
                <div style={HINT_STYLE}>
                  In use and cannot be changed. A different key would make the
                  Git credentials you have already saved unreadable.
                </div>
              ) : (
                state.isSet &&
                def.sensitive && (
                  <div style={HINT_STYLE}>
                    Saved. Leave blank to keep it, or enter a new value to
                    replace it.
                  </div>
                )
              )}
              {errors[def.key] && (
                <div
                  style={{
                    color: 'var(--status-danger, #f04438)',
                    fontSize: 12,
                  }}
                >
                  {errors[def.key]}
                </div>
              )}
            </div>
          )
        })}

        {saveError && (
          <Alert tone="danger" title="Save failed" description={saveError} />
        )}

        {phase === 'applying' && (
          <Alert
            tone="info"
            title="Saving"
            description="Applying your changes."
          />
        )}

        {phase === 'done' && (
          <Alert
            tone="success"
            title="Settings saved"
            description="Your changes are now in effect."
          />
        )}

        {phase === 'timeout' && (
          <Alert
            tone="warning"
            title="Saved, but not active yet"
            description="Your settings are stored safely, but Portainer-Run could not apply them just now. Try saving again, or they will take effect the next time it reloads."
          />
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ flex: 1 }} />
          <Button onClick={() => void handleSave()} disabled={busy || blocked}>
            {phase === 'saving'
              ? 'Saving…'
              : phase === 'applying'
                ? 'Applying…'
                : submitLabel}
          </Button>
        </div>
      </div>
    </Card>
  )
}
