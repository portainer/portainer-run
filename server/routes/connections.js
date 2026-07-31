import { readBody } from '../lib/http.js'
import { CORS } from '../lib/cors.js'
import {
  createConnection,
  getConnectionById,
  getConnectionsForUser,
  updateConnection,
  deleteConnection,
} from '../models/connection.js'
import {
  testGitConnection,
  getBranches,
  listFiles,
  githubApiBase,
} from '../proxy/git.js'
import { resolveCallerIdentity, extractToken } from '../lib/identity.js'
import https from 'node:https'
import http from 'node:http'

/**
 * Handle all /api/connections/* routes.
 */
export async function handleConnections(req, res, pathname) {
  const method = req.method

  if (!extractToken(req)) {
    return json(res, 401, { error: 'Unauthorized' })
  }

  // Resolve caller identity for ownership checks
  const caller = await resolveCallerIdentity(req)
  const userId = caller?.userId || '_unknown'
  const isAdmin = caller?.isAdmin || false

  // `tlsSkipVerify` is only meaningful for a self-hosted server with a custom URL — the
  // client hides the toggle otherwise, but that's a UI nicety, not enforcement. Normalize
  // here so a crafted request can't disable TLS verification against a public host.
  function normalizeGitPayload(payload) {
    if (payload.tlsSkipVerify && !payload.url) {
      return { ...payload, tlsSkipVerify: false }
    }
    return payload
  }

  function sanitize(conn) {
    if (!conn) return null
    const { payload, ...rest } = conn
    const safePayload = { ...payload }
    delete safePayload.token
    delete safePayload.sshKey
    delete safePayload.sshPassphrase
    return { ...rest, payload: safePayload, summary: buildSummary(conn) }
  }

  // GET /api/connections — own targets + shared targets
  if (pathname === '/api/connections' && method === 'GET') {
    const conns = getConnectionsForUser(userId).map(sanitize)
    return json(res, 200, { connections: conns })
  }

  // POST /api/connections
  if (pathname === '/api/connections' && method === 'POST') {
    const body = await readBody(req)
    const data = parseJson(body)
    if (!data?.name || !data?.payload) {
      return json(res, 400, { error: 'name and payload required' })
    }
    const payload = normalizeGitPayload(data.payload)
    try {
      const branches = await getBranches(payload)
      if (branches.length === 0) {
        return json(res, 422, {
          error:
            "Repository has no commits. Initialize the repository with at least one file using your Git provider before adding it as a target. See your provider's documentation for instructions.",
        })
      }
    } catch {
      // Can't reach repo or auth failed — not a blocking error here.
      // Use Test Connection to diagnose connectivity issues.
    }
    // Only admins can create shared targets
    const shared = isAdmin ? Boolean(data.shared) : false
    const conn = createConnection(data.name, payload, userId, shared)
    return json(res, 201, { connection: sanitize(conn) })
  }

  // POST /api/connections/test  (test without saving)
  if (pathname === '/api/connections/test' && method === 'POST') {
    const body = await readBody(req)
    const data = parseJson(body)
    if (!data?.payload) return json(res, 400, { error: 'payload required' })
    try {
      const result = await testGitConnection(normalizeGitPayload(data.payload))
      return json(res, 200, result)
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message })
    }
  }

  // Match /api/connections/:id
  const idMatch = pathname.match(/^\/api\/connections\/([^/]+)$/)
  if (idMatch && idMatch[1] !== 'test') {
    const id = idMatch[1]

    // GET /api/connections/:id — only owner or if shared
    if (method === 'GET') {
      const conn = getConnectionById(id)
      if (!conn) return json(res, 404, { error: 'Not found' })
      if (!isAdmin && conn.owner_id !== userId && !conn.shared) {
        return json(res, 403, { error: 'Forbidden' })
      }
      return json(res, 200, { connection: sanitize(conn) })
    }

    // PUT /api/connections/:id
    if (method === 'PUT') {
      const body = await readBody(req)
      const data = parseJson(body)
      if (!data?.name || !data?.payload) {
        return json(res, 400, { error: 'name and payload required' })
      }
      const payload = normalizeGitPayload(data.payload)
      try {
        const branches = await getBranches(payload)
        if (branches.length === 0) {
          return json(res, 422, {
            error:
              "Repository has no commits. Initialize the repository with at least one file using your Git provider before saving this target. See your provider's documentation for instructions.",
          })
        }
      } catch {
        // Can't reach repo or auth failed — not a blocking error here.
      }
      const result = updateConnection(
        id,
        data.name,
        payload,
        data.shared,
        userId,
        isAdmin,
      )
      if (result === 'forbidden') return json(res, 403, { error: 'Forbidden' })
      if (!result) return json(res, 404, { error: 'Not found' })
      return json(res, 200, { connection: sanitize(result) })
    }

    // DELETE /api/connections/:id
    if (method === 'DELETE') {
      const result = deleteConnection(id, userId, isAdmin)
      if (result === 'forbidden') return json(res, 403, { error: 'Forbidden' })
      if (result === 'notfound') return json(res, 404, { error: 'Not found' })
      return json(res, 200, { ok: true })
    }
  }

  // POST /api/connections/:id/initialize
  const initMatch = pathname.match(/^\/api\/connections\/([^/]+)\/initialize$/)
  if (initMatch && method === 'POST') {
    const id = initMatch[1]
    const conn = getConnectionById(id)
    if (!conn) return json(res, 404, { error: 'Connection not found' })
    if (!isAdmin && conn.owner_id !== userId)
      return json(res, 403, { error: 'Forbidden' })
    try {
      const { provider, repo } = conn.payload
      const headers = buildGitHeaders(conn.payload)
      if (provider === 'github') {
        const base = githubApiBase(conn.payload)
        const skipVerify = Boolean(conn.payload.tlsSkipVerify)
        const repoData = await gitRequest(
          'GET',
          `${base}/repos/${repo}`,
          headers,
          undefined,
          skipVerify,
        )
        const defaultBranch = repoData.default_branch
        const tree = await gitRequest(
          'POST',
          `${base}/repos/${repo}/git/trees`,
          headers,
          {
            tree: [
              {
                path: 'README.md',
                mode: '100644',
                type: 'blob',
                content: `# ${repo.split('/').pop()}\n`,
              },
            ],
          },
          skipVerify,
        )
        const commit = await gitRequest(
          'POST',
          `${base}/repos/${repo}/git/commits`,
          headers,
          {
            message: 'chore: initialise repository',
            tree: tree.sha,
            parents: [],
          },
          skipVerify,
        )
        await gitRequest(
          'POST',
          `${base}/repos/${repo}/git/refs`,
          headers,
          {
            ref: `refs/heads/${defaultBranch}`,
            sha: commit.sha,
          },
          skipVerify,
        )
        return json(res, 200, { ok: true, branch: defaultBranch })
      }
      return json(res, 400, {
        error: 'Initialize not supported for this provider yet',
      })
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
    if (!isAdmin && conn.owner_id !== userId && !conn.shared)
      return json(res, 403, { error: 'Forbidden' })
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
    if (!isAdmin && conn.owner_id !== userId && !conn.shared)
      return json(res, 403, { error: 'Forbidden' })
    try {
      const branches = await getBranches(conn.payload)
      return json(res, 200, { branches })
    } catch (err) {
      return json(res, 502, { error: err.message })
    }
  }

  // GET /api/connections/:id/files?branch=&path=
  // Lists a single directory level at `path` (repo root when omitted) for
  // runtime detection and the lazy-loading source folder picker.
  const filesMatch = pathname.match(/^\/api\/connections\/([^/]+)\/files$/)
  if (filesMatch && method === 'GET') {
    const id = filesMatch[1]
    const conn = getConnectionById(id)
    if (!conn) return json(res, 404, { error: 'Not found' })
    if (!isAdmin && conn.owner_id !== userId && !conn.shared)
      return json(res, 403, { error: 'Forbidden' })
    const url = new URL(req.url, 'http://localhost')
    const branch =
      url.searchParams.get('branch') || conn.payload.defaultBranch || 'main'
    const path = url.searchParams.get('path') || ''
    try {
      const files = await listFiles(conn.payload, branch, path)
      return json(res, 200, { files })
    } catch (err) {
      return json(res, 502, { error: err.message })
    }
  }

  return null
}

// --- helpers ---

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

function parseJson(body) {
  if (!body || !body.length) return null
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
}

function buildSummary(conn) {
  const p = conn.payload
  return `${p.provider || 'git'} — ${p.repo}`
}

function buildGitHeaders(payload) {
  const h = {
    'Content-Type': 'application/json',
    'User-Agent': 'portainer-run',
  }
  if (payload.token) h['Authorization'] = `token ${payload.token}`
  return h
}

function gitRequest(method, urlStr, headers, body, skipVerify) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const bodyStr = body ? JSON.stringify(body) : undefined
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      rejectUnauthorized: !skipVerify,
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(opts, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        if (res.statusCode >= 400)
          return reject(
            new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`),
          )
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve(text)
        }
      })
    })
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}
