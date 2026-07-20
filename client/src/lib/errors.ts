/** Extract a human-readable message from an unknown thrown value. */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * True when a thrown value is a fetch/stream abort (e.g. a request cancelled
 * via AbortController). These are expected during teardown and must not be
 * surfaced as errors. Matches by `name` since aborts arrive as a DOMException,
 * which does not reliably satisfy `instanceof Error` across environments.
 */
export function isAbortError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    (e as { name?: unknown }).name === 'AbortError'
  )
}
