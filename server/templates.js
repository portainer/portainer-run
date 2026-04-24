import http from 'node:http'
import https from 'node:https'
import { TEMPLATE_URL } from './config.js'
import { CORS } from './lib/cors.js'

let templateCache = null
let templateCacheTime = 0
const TEMPLATE_CACHE_TTL = 5 * 60 * 1000

function fetchTemplates() {
  const now = Date.now()
  if (templateCache && now - templateCacheTime < TEMPLATE_CACHE_TTL) {
    return Promise.resolve(templateCache)
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(TEMPLATE_URL)
    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.get(
      TEMPLATE_URL,
      { headers: { 'User-Agent': 'portainer-run/1.0' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            const data = JSON.parse(body)
            templateCache = data
            templateCacheTime = Date.now()
            resolve(data)
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e))
            reject(new Error('Failed to parse templates: ' + err.message))
          }
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export function handleTemplates(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, CORS)
    res.end()
    return
  }
  fetchTemplates()
    .then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
      res.end(JSON.stringify(data))
    })
    .catch((e) => {
      const err = e instanceof Error ? e : new Error(String(e))
      console.error('[templates]', err.message)
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS })
      res.end(
        JSON.stringify({ error: 'Could not load templates', message: err.message })
      )
    })
}
