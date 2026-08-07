import https from 'node:https'
import { CORS } from '../lib/cors.js'
import { anthropicKey } from '../settings.js'

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Buffer} body
 */
export function proxyToAnthropic(req, res, body) {
  if (!anthropicKey()) {
    res.writeHead(503, { 'Content-Type': 'application/json', ...CORS })
    res.end(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on server' }),
    )
    return
  }
  let payload
  try {
    payload = JSON.parse(body.toString())
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }
  const outBody = Buffer.from(JSON.stringify(payload))
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': anthropicKey(),
    'anthropic-version': '2023-06-01',
    'Content-Length': outBody.length,
  }
  const upstream = https.request(
    {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers,
      port: 443,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, {
        ...CORS,
        'Content-Type': upRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
      upRes.pipe(res)
    },
  )
  upstream.on('error', (e) => {
    console.error('[anthropic proxy error]', e.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS })
      res.end(JSON.stringify({ error: e.message }))
    }
  })
  upstream.write(outBody)
  upstream.end()
}
