import { Alert } from '@ds/v3-components/Alert/Alert'

export interface GitTestResult {
  ok: boolean
  message: string
  permissions?: { canWrite?: boolean }
  details?: string[]
  isEmpty?: boolean
}

/** Success / read-only warning / failure summary of a git connection test. */
export function TestResultAlert({ result }: { result: GitTestResult }) {
  const tone = result.ok
    ? result.permissions?.canWrite
      ? 'success'
      : 'warning'
    : 'danger'
  return (
    <Alert
      tone={tone}
      title={result.message}
      description={
        // Alert renders the description inside a <p>, so only phrasing content
        // is valid here — spans styled as blocks, not divs.
        result.details && result.details.length > 0 ? (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {result.details.map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </span>
        ) : undefined
      }
    />
  )
}
