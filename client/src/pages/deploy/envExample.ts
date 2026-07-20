// ---------------------------------------------------------------------------
// .env.example parsing
// ---------------------------------------------------------------------------

export interface EnvVar {
  key: string
  value: string
  custom?: boolean
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
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key) vars.push({ key, value: val })
  }
  return vars
}
