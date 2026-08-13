import { portainerAuthHeaders } from './identity.js'
import { portainerHttpRequest } from './portainer-tls.js'

/**
 * Request Portainer's API. `token` is either the inbound caller's own
 * credential or this add-on's machine token.
 *
 * @param {{ host: string, port: number, isHttps: boolean }} target
 * @param {string} token
 * @param {string} method
 * @param {string} path
 * @param {string} [body]
 * @param {string} [contentType]
 */
export function portainerRequest(
  target,
  token,
  method,
  path,
  body,
  contentType = 'application/json',
) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': contentType, Accept: 'application/json' }
    if (token) Object.assign(headers, portainerAuthHeaders(token))
    if (body) headers['Content-Length'] = Buffer.byteLength(body)

    const reqOut = portainerHttpRequest(
      target,
      { path, method, headers },
      (upRes) => {
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
      },
    )

    reqOut.on('error', reject)
    if (body) reqOut.write(body)
    reqOut.end()
  })
}
