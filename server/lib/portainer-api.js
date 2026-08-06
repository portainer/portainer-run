import https from 'node:https'
import http from 'node:http'
import { portainerAuthHeaders } from './identity.js'

/**
 * Make a request to Portainer's API on behalf of a caller.
 *
 * `userToken` is always the inbound caller's own credential: Portainer-Run has
 * no identity of its own, so privileged calls are the user's session forwarded.
 *
 * @param {{ host: string, port: number, isHttps: boolean }} target
 * @param {string} userToken
 * @param {string} method
 * @param {string} path
 * @param {string} [body]
 * @param {string} [contentType]
 */
export function portainerRequest(
  target,
  userToken,
  method,
  path,
  body,
  contentType = 'application/json',
) {
  return new Promise((resolve, reject) => {
    const transport = target.isHttps ? https : http
    const headers = { 'Content-Type': contentType, Accept: 'application/json' }
    if (userToken) Object.assign(headers, portainerAuthHeaders(userToken))
    if (body) headers['Content-Length'] = Buffer.byteLength(body)

    const opts = {
      hostname: target.host,
      port: target.port,
      path,
      method,
      headers,
      rejectUnauthorized: false,
    }

    const reqOut = transport.request(opts, (upRes) => {
      const chunks = []
      upRes.on('data', (c) => chunks.push(c))
      upRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (upRes.statusCode >= 400) {
          // Keep the method/path/status alongside Portainer's own message so a
          // routing 404 ("Not Found") is distinguishable from a resource 404.
          let detail = ''
          try {
            const parsed = JSON.parse(text)
            detail = parsed?.message || parsed?.details || ''
          } catch {
            /* ignore */
          }
          const err = new Error(
            `Portainer ${method} ${path.split('?')[0]} → HTTP ${upRes.statusCode}` +
              (detail ? `: ${detail}` : ''),
          )
          err.status = upRes.statusCode
          err.method = method
          err.url = path.split('?')[0]
          return reject(err)
        }
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve(text)
        }
      })
    })

    reqOut.on('error', reject)
    if (body) reqOut.write(body)
    reqOut.end()
  })
}
