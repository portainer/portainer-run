import fs from 'node:fs'
import crypto from 'node:crypto'
import { CACHE_DIR, CACHE_FILE } from './config.js'
import { CORS } from './lib/cors.js'
import { readBody } from './lib/http.js'
import { resolvePortainerTarget } from './resolve-portainer.js'
import { extractToken } from './lib/identity.js'

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
}

/**
 * @param {string} token
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {string | null} cache key, or null if a 400 was sent
 */
function getCacheFileKeyOrReject(token, req, res) {
  const target = resolvePortainerTarget()
  if (!target) {
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
      res.end(
        JSON.stringify({
          error: 'Server is misconfigured: PORTAINER_URL is not set.',
        })
      )
    }
    return null
  }
  return crypto
    .createHash('sha256')
    .update(token + ':' + target.key)
    .digest('hex')
}

function readCacheFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    }
  } catch {
    // ignore
  }
  return {}
}

function writeCacheFile(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8')
  } catch (e) {
    console.warn('[cache] write failed:', e.message)
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export function handleCache(req, res) {
  const token = extractToken(req)
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }
  const key = getCacheFileKeyOrReject(token, req, res)
  if (key == null) return

  if (req.method === 'GET') {
    const all = readCacheFile()
    const entry = all[key] || null
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify(entry))
    return
  }

  if (req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const data = JSON.parse((body || Buffer.from('')).toString())
        const all = readCacheFile()
        all[key] = { ...data, savedAt: Date.now() }
        writeCacheFile(all)
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
        res.end(JSON.stringify({ ok: true }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    })
    return
  }

  if (req.method === 'DELETE') {
    const all = readCacheFile()
    delete all[key]
    writeCacheFile(all)
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.writeHead(405, CORS)
  res.end()
}
