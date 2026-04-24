import { TEMPLATE_URL } from './config.js'
import { CORS } from './lib/cors.js'

let templateCache = null
let templateCacheTime = 0
const TEMPLATE_CACHE_TTL = 5 * 60 * 1000

async function loadTemplatesFromSource() {
  const res = await fetch(TEMPLATE_URL, {
    headers: { 'User-Agent': 'portainer-run/1.0' },
    redirect: 'follow',
  })
  const body = await res.text()
  if (!res.ok) {
    const preview = body.slice(0, 200).replace(/\s+/g, ' ')
    throw new Error(
      `Catalogue URL returned HTTP ${res.status} ${res.statusText}${preview ? `: ${preview}` : ''}`,
    )
  }
  try {
    return JSON.parse(body)
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    throw new Error('Failed to parse templates JSON: ' + err.message)
  }
}

function fetchTemplates() {
  const now = Date.now()
  if (templateCache && now - templateCacheTime < TEMPLATE_CACHE_TTL) {
    return Promise.resolve(templateCache)
  }
  return loadTemplatesFromSource().then((data) => {
    templateCache = data
    templateCacheTime = Date.now()
    return data
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
