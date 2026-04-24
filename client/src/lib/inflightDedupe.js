/** @type {Map<string, Promise<unknown>>} */
const INFLIGHT = new Map()

/**
 * Share one promise per `key` while work is in flight (React Strict Mode remounts, rapid tab switches).
 * Registers the promise before the microtask that runs `fn`, so synchronous double-invoke cannot start two fetches.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function inflightDedupe(key, fn) {
  const existing = INFLIGHT.get(key)
  if (existing) return /** @type {Promise<T>} */ (existing)
  const task = Promise.resolve().then(fn)
  INFLIGHT.set(key, task)
  task.finally(() => {
    if (INFLIGHT.get(key) === task) INFLIGHT.delete(key)
  })
  return /** @type {Promise<T>} */ (task)
}
