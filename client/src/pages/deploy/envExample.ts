// ---------------------------------------------------------------------------
// .env.example parsing
// ---------------------------------------------------------------------------

export interface EnvVar {
  /** Stable identity for React keys and row edits; not persisted. */
  id: string
  key: string
  value: string
  custom?: boolean
}

/** Generate a stable, unique id for an environment variable row. */
export function newEnvVarId(): string {
  return crypto.randomUUID()
}

/** Parse a `.env.example` file body into key/value pairs, ignoring comments. */
export function parseEnvExample(text: string): EnvVar[] {
  const vars: EnvVar[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (key) vars.push({ id: newEnvVarId(), key, value: val })
  }
  return vars
}
