import https from 'node:https'
import http from 'node:http'

/**
 * Commit one or more files to a git repo.
 * @param {object} payload  decrypted connection payload
 * @param {string} branch
 * @param {string} message
 * @param {{ path: string, content: string }[]} files
 */
export async function commitFiles(payload, branch, message, files) {
  const { provider } = payload
  if (provider === 'github') return commitGitHub(payload, branch, message, files)
  if (provider === 'gitlab') return commitGitLab(payload, branch, message, files)
  return commitGitea(payload, branch, message, files)
}

/**
 * List branches for the configured repo.
 * @param {object} payload
 * @returns {Promise<string[]>}
 */
export async function getBranches(payload) {
  const { provider, repo, url: baseUrl } = payload
  const headers = buildHeaders(payload)

  if (provider === 'github') {
    const data = await request('GET', `https://api.github.com/repos/${repo}/branches`, headers)
    return data.map((b) => b.name)
  }
  if (provider === 'gitlab') {
    const base = baseUrl || 'https://gitlab.com'
    const encoded = encodeURIComponent(repo)
    const data = await request('GET', `${base}/api/v4/projects/${encoded}/repository/branches`, headers)
    return data.map((b) => b.name)
  }
  const base = baseUrl || ''
  const data = await request('GET', `${base}/api/v1/repos/${repo}/branches`, headers)
  return data.map((b) => b.name)
}

/**
 * Ensure a branch exists, creating from default branch if not.
 * @param {object} payload
 * @param {string} branch
 */
export async function ensureBranch(payload, branch) {
  const { provider, repo, url: baseUrl } = payload
  const headers = buildHeaders(payload)
  const branches = await getBranches(payload)
  if (branches.includes(branch)) return { ok: true, created: false }

  if (provider === 'github') {
    const repoData = await request('GET', `https://api.github.com/repos/${repo}`, headers)
    const defaultBranch = repoData.default_branch
    const refData = await request('GET', `https://api.github.com/repos/${repo}/git/ref/heads/${defaultBranch}`, headers)
    await request('POST', `https://api.github.com/repos/${repo}/git/refs`, headers, {
      ref: `refs/heads/${branch}`,
      sha: refData.object.sha,
    })
    return { ok: true, created: true }
  }

  if (provider === 'gitlab') {
    const base = baseUrl || 'https://gitlab.com'
    const encoded = encodeURIComponent(repo)
    const projData = await request('GET', `${base}/api/v4/projects/${encoded}`, headers)
    await request('POST', `${base}/api/v4/projects/${encoded}/repository/branches`, headers, {
      branch,
      ref: projData.default_branch,
    })
    return { ok: true, created: true }
  }

  // Gitea
  const base = baseUrl || ''
  const repoData = await request('GET', `${base}/api/v1/repos/${repo}`, headers)
  await request('POST', `${base}/api/v1/repos/${repo}/branches`, headers, {
    new_branch_name: branch,
    old_branch_name: repoData.default_branch,
  })
  return { ok: true, created: true }
}

// --- provider implementations ---

async function commitGitHub(payload, branch, message, files) {
  const { repo } = payload
  const headers = buildHeaders(payload)
  const base = 'https://api.github.com'

  // Get branch SHA — gracefully handle empty/new repos
  let baseSha = null
  let baseTree = null
  let parents = []

  try {
    const refData = await request('GET', `${base}/repos/${repo}/git/ref/heads/${branch}`, headers)
    baseSha = refData.object.sha
    const commitData = await request('GET', `${base}/repos/${repo}/git/commits/${baseSha}`, headers)
    baseTree = commitData.tree.sha
    parents = [baseSha]
  } catch {
    // Empty repo or branch doesn't exist yet — start from scratch
  }

  // Create blobs
  const treeItems = await Promise.all(
    files.map(async (f) => {
      const blobData = await request('POST', `${base}/repos/${repo}/git/blobs`, headers, {
        content: Buffer.from(f.content).toString('base64'),
        encoding: 'base64',
      })
      return { path: f.path, mode: '100644', type: 'blob', sha: blobData.sha }
    }),
  )

  // Create tree
  const treeBody = baseTree
    ? { base_tree: baseTree, tree: treeItems }
    : { tree: treeItems }
  const newTree = await request('POST', `${base}/repos/${repo}/git/trees`, headers, treeBody)

  // Create commit
  const newCommit = await request('POST', `${base}/repos/${repo}/git/commits`, headers, {
    message,
    tree: newTree.sha,
    parents,
  })

  // Update or create ref
  try {
    await request('PATCH', `${base}/repos/${repo}/git/refs/heads/${branch}`, headers, {
      sha: newCommit.sha,
      force: true,
    })
  } catch {
    await request('POST', `${base}/repos/${repo}/git/refs`, headers, {
      ref: `refs/heads/${branch}`,
      sha: newCommit.sha,
    })
  }

  return { ok: true, sha: newCommit.sha }
}

async function commitGitLab(payload, branch, message, files) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || 'https://gitlab.com'
  const encoded = encodeURIComponent(repo)
  const headers = buildHeaders(payload)

  const actions = files.map((f) => ({
    action: 'create',
    file_path: f.path,
    content: f.content,
    encoding: 'text',
    force: true,
  }))

  const data = await request(
    'POST',
    `${base}/api/v4/projects/${encoded}/repository/commits`,
    headers,
    { branch, commit_message: message, actions },
  )
  return { ok: true, sha: data.id }
}

async function commitGitea(payload, branch, message, files) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || ''
  const headers = buildHeaders(payload)

  for (const f of files) {
    let sha = null
    try {
      const existing = await request(
        'GET',
        `${base}/api/v1/repos/${repo}/contents/${f.path}?ref=${branch}`,
        headers,
      )
      sha = existing.sha
    } catch {
      // File doesn't exist yet
    }

    const body = {
      message,
      content: Buffer.from(f.content).toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }

    await request(
      sha ? 'PUT' : 'POST',
      `${base}/api/v1/repos/${repo}/contents/${f.path}`,
      headers,
      body,
    )
  }
  return { ok: true }
}

// --- helpers ---

function buildHeaders(payload) {
  if (payload.provider === 'github') {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'portainer-run' }
    if (payload.token) headers['Authorization'] = `token ${payload.token}`
    return headers
  }
  if (payload.provider === 'gitlab') {
    return { 'PRIVATE-TOKEN': payload.token }
  }
  return { Authorization: `token ${payload.token}` }
}

/**
 * Minimal HTTP/HTTPS request helper — no external dependencies.
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
 * @param {string} urlStr
 * @param {object} headers
 * @param {object} [body]
 * @returns {Promise<any>} parsed JSON response
 */
function request(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const transport = u.protocol === 'https:' ? https : http
    const bodyStr = body ? JSON.stringify(body) : null
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    }
    if (bodyStr) reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr)

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: reqHeaders,
      rejectUnauthorized: false,
    }

    const req = transport.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode >= 400) {
          let msg = `HTTP ${res.statusCode}`
          try { msg = JSON.parse(text)?.message || msg } catch { /* ignore */ }
          return reject(new Error(msg))
        }
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


/**
 * Delete a single file from the repo.
 * @param {object} payload  decrypted connection payload
 * @param {string} branch
 * @param {string} filePath
 * @param {string} message  commit message
 */
export async function deleteFile(payload, branch, filePath, message) {
  const { provider } = payload
  if (provider === 'github') return deleteFileGitHub(payload, branch, filePath, message)
  if (provider === 'gitlab') return deleteFileGitLab(payload, branch, filePath, message)
  return deleteFileGitea(payload, branch, filePath, message)
}

async function deleteFileGitHub(payload, branch, filePath, message) {
  const { repo } = payload
  const headers = buildHeaders(payload)
  const base = 'https://api.github.com'

  // Get current file SHA — required by GitHub delete API
  const fileData = await request('GET', `${base}/repos/${repo}/contents/${filePath}?ref=${branch}`, headers)
  const sha = fileData.sha
  if (!sha) throw new Error('Could not retrieve file SHA for deletion')

  await request('DELETE', `${base}/repos/${repo}/contents/${filePath}`, headers, {
    message,
    sha,
    branch,
  })
  return { ok: true }
}

async function deleteFileGitLab(payload, branch, filePath, message) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || 'https://gitlab.com'
  const encoded = encodeURIComponent(repo)
  const encodedPath = encodeURIComponent(filePath)
  const headers = buildHeaders(payload)

  await request(
    'DELETE',
    `${base}/api/v4/projects/${encoded}/repository/files/${encodedPath}`,
    headers,
    { branch, commit_message: message },
  )
  return { ok: true }
}

async function deleteFileGitea(payload, branch, filePath, message) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || ''
  const headers = buildHeaders(payload)

  // Get current file SHA
  const fileData = await request('GET', `${base}/api/v1/repos/${repo}/contents/${filePath}?ref=${branch}`, headers)
  const sha = fileData.sha
  if (!sha) throw new Error('Could not retrieve file SHA for deletion')

  await request('DELETE', `${base}/api/v1/repos/${repo}/contents/${filePath}`, headers, {
    message,
    sha,
    branch,
  })
  return { ok: true }
}

/**
 * Build the HTTPS repo URL from a connection payload (for Portainer GitOps stack creation).
 * @param {object} payload
 * @returns {string}
 */
export function buildRepoHttpsUrl(payload) {
  const { provider, repo, url: baseUrl } = payload
  if (provider === 'github') return `https://github.com/${repo}`
  if (provider === 'gitlab') {
    const base = (baseUrl || 'https://gitlab.com').replace(/\/$/, '')
    return `${base}/${repo}`
  }
  const base = (baseUrl || '').replace(/\/$/, '')
  return `${base}/${repo}`
}

/**
 * Test that the Git repo is accessible with the provided credentials.
 * @param {object} payload
 */
export async function testGitConnection(payload) {
  const { provider, repo, url: baseUrl } = payload
  const headers = buildHeaders(payload)
  if (provider === 'github') {
    await request('GET', `https://api.github.com/repos/${repo}`, headers)
    return { ok: true, message: 'GitHub repository accessible' }
  }
  if (provider === 'gitlab') {
    const base = baseUrl || 'https://gitlab.com'
    const encoded = encodeURIComponent(repo)
    await request('GET', `${base}/api/v4/projects/${encoded}`, headers)
    return { ok: true, message: 'GitLab repository accessible' }
  }
  const base = baseUrl || ''
  await request('GET', `${base}/api/v1/repos/${repo}`, headers)
  return { ok: true, message: 'Gitea repository accessible' }
}
