/**
 * @param {number} concurrency
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(concurrency) {
  let active = 0
  const queue = []
  return function run(fn) {
    return new Promise((resolve, reject) => {
      const next = () => {
        if (!queue.length) return
        if (active >= concurrency) return
        active++
        const { fn: f, resolve: res, reject: rej } = queue.shift()
        Promise.resolve()
          .then(f)
          .then((v) => {
            active--
            res(v)
            next()
          })
          .catch((e) => {
            active--
            rej(e)
            next()
          })
      }
      queue.push({ fn, resolve, reject })
      next()
    })
  }
}
