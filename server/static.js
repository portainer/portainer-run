import fs from 'node:fs'
import path from 'node:path'
import { DIST_DIR, LEGACY_HTML } from './config.js'

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Serves the Vite build from client/dist, or old-implementation/portainer-run.html as fallback.
 * @returns {boolean} true if a response was sent
 */
export function tryServeStatic(pathname, res) {
  const hasDist = fs.existsSync(DIST_DIR)
  if (hasDist) {
    const rel =
      pathname === '/' || pathname === '/index.html'
        ? 'index.html'
        : pathname.slice(1)
    if (!rel) return false
    const filePath = path.join(DIST_DIR, rel)
    const distAbs = path.resolve(DIST_DIR)
    if (
      !path.resolve(filePath).startsWith(distAbs + path.sep) &&
      path.resolve(filePath) !== distAbs
    ) {
      return false
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath)
      return serveFile(
        filePath,
        res,
        contentTypes[ext] || 'application/octet-stream',
      )
    }
    const index = path.join(DIST_DIR, 'index.html')
    if (fs.existsSync(index) && (pathname === '/' || !path.extname(pathname))) {
      return serveFile(index, res, 'text/html; charset=utf-8')
    }
  }

  if (pathname === '/' || pathname === '/index.html') {
    if (fs.existsSync(LEGACY_HTML)) {
      return serveFile(LEGACY_HTML, res, 'text/html; charset=utf-8')
    }
  }
  return false
}

/**
 * @param {string} filePath
 * @param {import('http').ServerResponse} res
 * @param {string} contentType
 * @returns {boolean}
 */
function serveFile(filePath, res, contentType) {
  if (!fs.existsSync(filePath)) return false
  res.writeHead(200, { 'Content-Type': contentType })
  fs.createReadStream(filePath).pipe(res)
  return true
}
