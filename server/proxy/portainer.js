import http from 'node:http'
import https from 'node:https'
import { CORS } from '../lib/cors.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} upstreamPath
 * @param {Buffer | null} body
 */
export function proxyToPortainer(req, res, upstreamPath, body) {
  const userToken = req.headers['x-api-key'] || ''
  const target = resolvePortainerTarget(req)
  if (!target) {
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
      res.end(
        JSON.stringify({
          error:
            'Set PORTAINER_URL on the server, or pass X-Portainer-URL (your Portainer base URL) on the request',
        })
      )
    }
    return
  }

  const transport = target.isHttps ? https : http
  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    Accept: 'application/json',
  }
  if (userToken) headers['X-API-Key'] = userToken
  if (body && body.length) headers['Content-Length'] = body.length

  const opts = {
    hostname: target.host,
    port: target.port,
    path: upstreamPath,
    method: req.method,
    headers,
    rejectUnauthorized: false,
  }
  const upstream = transport.request(opts, (upRes) => {
    const resHeaders = {
      ...CORS,
      'Content-Type': upRes.headers['content-type'] || 'application/json',
    }
    if (upRes.headers['content-encoding'])
      resHeaders['Content-Encoding'] = upRes.headers['content-encoding']
    res.writeHead(upRes.statusCode || 502, resHeaders)
    upRes.pipe(res)
  })
  upstream.on('error', (e) => {
    console.error('[portainer proxy error]', e.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS })
      res.end(JSON.stringify({ error: 'Proxy error', message: e.message }))
    }
  })
  if (body && body.length) upstream.write(body)
  upstream.end()
}
