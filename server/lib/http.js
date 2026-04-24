/** @param {import('http').IncomingMessage} req */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null))
    req.on('error', reject)
  })
}
