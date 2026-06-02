import { readBody } from '../lib/http.js'
import { CORS } from '../lib/cors.js'
import {
  createConnection,
  getAllConnections,
  getConnectionById,
  updateConnection,
  deleteConnection,
} from '../models/connection.js'
import { testGitConnection } from '../proxy/git.js'

/**
 * Handle all /api/connections/* routes.
 * Mounted from handler.js.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 */
export async function handleConnections(req, res, pathname) {
  const method = req.method

  // Require a Portainer API token on all connection routes
  if (!req.headers['x-api-key']) {
    return json(res, 401, { error: 'Unauthorized' })
  }

  // Strip sensitive fields for list/get responses
  function sanitize(conn) {
    if (!conn) return null
    const { payload, ...rest } = conn
    const safePayload = { ...payload }
    delete safePayload.token
    delete safePayload.sshKey
    delete safePayload.sshPassphrase
    return {
      ...rest,
      payload: safePayload,
      summary: buildSummary(conn),
    }
  }

  // GET /api/connections
  if (pathname === '/api/connections' && method === 'GET') {
    const conns = getAllConnections().map(sanitize)
    return json(res, 200, { connections: conns })
  }

  // POST /api/connections
  if (pathname === '/api/connections' && method === 'POST') {
    const body = await readBody(req)
    const data = parseJson(body)
    if (!data?.name || !data?.payload) {
      return json(res, 400, { error: 'name and payload required' })
    }
    const conn = createConnection(data.name, data.payload)
    return json(res, 201, { connection: sanitize(conn) })
  }

  // POST /api/connections/test  (test without saving)
  if (pathname === '/api/connections/test' && method === 'POST') {
    const body = await readBody(req)
    const data = parseJson(body)
    if (!data?.payload) return json(res, 400, { error: 'payload required' })
    try {
      const result = await testGitConnection(data.payload)
      return json(res, 200, result)
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message })
    }
  }

  // Match /api/connections/:id — explicitly exclude reserved path segments
  const idMatch = pathname.match(/^\/api\/connections\/([^/]+)$/)
  if (idMatch && idMatch[1] !== 'test') {
    const id = idMatch[1]

    // GET /api/connections/:id  — returns full payload including token for edit form
    if (method === 'GET') {
      const conn = getConnectionById(id)
      if (!conn) return json(res, 404, { error: 'Not found' })
      return json(res, 200, { connection: conn })
    }

    // PUT /api/connections/:id
    if (method === 'PUT') {
      const body = await readBody(req)
      const data = parseJson(body)
      if (!data?.name || !data?.payload) {
        return json(res, 400, { error: 'name and payload required' })
      }
      const conn = updateConnection(id, data.name, data.payload)
      if (!conn) return json(res, 404, { error: 'Not found' })
      return json(res, 200, { connection: sanitize(conn) })
    }

    // DELETE /api/connections/:id
    if (method === 'DELETE') {
      deleteConnection(id)
      return json(res, 200, { ok: true })
    }
  }

  // POST /api/connections/:id/initialize  (create initial commit on empty repo)
  const initMatch = pathname.match(/^\/api\/connections\/([^/]+)\/initialize$/)
  if (initMatch && method === 'POST') {
    const id = initMatch[1]
    const conn = getConnectionById(id)
    if (!conn) return json(res, 404, { error: 'Connection not found' })
    try {
      const { provider, repo } = conn.payload
      const headers = buildHeaders(conn.payload)
      if (provider === 'github') {
        const base = 'https://api.github.com'
        const repoData = await request('GET', `${base}/repos/${repo}`, headers)
        const defaultBranch = repoData.default_branch
        const tree = await request('POST', `${base}/repos/${repo}/git/trees`, headers, {
          tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: `# ${repo.split('/').pop()}
` }],
        })
        const commit = await request('POST', `${base}/repos/${repo}/git/commits`, headers, {
          message: 'chore: initialise repository',
          tree: tree.sha,
          parents: [],
        })
        await request('POST', `${base}/repos/${repo}/git/refs`, headers, {
          ref: `refs/heads/${defaultBranch}`,
          sha: commit.sha,
        })
        return json(res, 200, { ok: true, branch: defaultBranch })
      }
      return json(res, 400, { error: 'Initialize not supported for this provider yet' })
    } catch (e) {
      return json(res, 502, { error: e.message || 'Initialize failed' })
    }
  }

  // POST /api/connections/:id/test
  const testMatch = pathname.match(/^\/api\/connections\/([^/]+)\/test$/)
  if (testMatch && method === 'POST') {
    const id = testMatch[1]
    const conn = getConnectionById(id)
    if (!conn) return json(res, 404, { error: 'Not found' })
    try {
      const result = await testGitConnection(conn.payload)
      return json(res, 200, result)
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message })
    }
  }

  // GET /api/connections/:id/branches
  const branchMatch = pathname.match(/^\/api\/connections\/([^/]+)\/branches$/)
  if (branchMatch && method === 'GET') {
    const id = branchMatch[1]
    const conn = getConnectionById(id)
    if (!conn) return json(res, 404, { error: 'Not found' })
    try {
      const { getBranches } = await import('../proxy/git.js')
      const branches = await getBranches(conn.payload)
      return json(res, 200, { branches })
    } catch (err) {
      return json(res, 502, { error: err.message })
    }
  }

  return null // not handled — caller will 404
}

// --- helpers ---

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

function parseJson(body) {
  if (!body || !body.length) return null
  try { return JSON.parse(body.toString('utf8')) } catch { return null }
}

function buildSummary(conn) {
  const p = conn.payload
  return `${p.provider || 'git'} — ${p.repo}`
}
