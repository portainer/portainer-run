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
    const base = 'https://api.github.com'
    const repoData = await request('GET', `${base}/repos/${repo}`, headers)
    const defaultBranch = repoData.default_branch
    const refData = await request('GET', `${base}/repos/${repo}/git/ref/heads/${defaultBranch}`, headers)
    const sha = refData.object.sha
    if (branch === defaultBranch) return { ok: true, created: false }
    await request('POST', `${base}/repos/${repo}/git/refs`, headers, {
      ref: `refs/heads/${branch}`,
      sha,
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
 * Delete all files under a directory path in the repo.
 * Lists the directory recursively and deletes each file individually.
 * @param {object} payload
 * @param {string} branch
 * @param {string} dirPath
 * @param {string} message
 */
export async function deleteDirectory(payload, branch, dirPath, message) {
  const { provider } = payload
  if (provider === 'github') return deleteDirectoryGitHub(payload, branch, dirPath, message)
  if (provider === 'gitlab') return deleteDirectoryGitLab(payload, branch, dirPath, message)
  return deleteDirectoryGitea(payload, branch, dirPath, message)
}

/**
 * GitHub: delete a directory in a single commit using the Git Data API tree approach.
 * Fetches the full recursive tree, filters out all entries under dirPath,
 * creates a new tree and commit, then updates the branch ref.
 * This matches what the GitHub UI 'Delete directory' button does.
 */
async function deleteDirectoryGitHub(payload, branch, dirPath, message) {
  const { repo } = payload
  const headers = buildHeaders(payload)
  const base = 'https://api.github.com'
  const prefix = dirPath.replace(/\/$/, '') + '/'

  // 1. Get current branch commit SHA
  const refData = await request('GET', `${base}/repos/${repo}/git/ref/heads/${branch}`, headers)
  const commitSha = refData.object.sha

  // 2. Get the current commit to find the tree SHA and parent
  const commitData = await request('GET', `${base}/repos/${repo}/git/commits/${commitSha}`, headers)
  const treeSha = commitData.tree.sha

  // 3. Get the full recursive tree
  const treeData = await request('GET', `${base}/repos/${repo}/git/trees/${treeSha}?recursive=1`, headers)
  const remaining = treeData.tree.filter((entry) => !entry.path.startsWith(prefix))

  if (remaining.length === treeData.tree.length) return { ok: true, deleted: 0 } // nothing to delete

  // 4. Create a new tree with only the remaining entries
  const newTree = await request('POST', `${base}/repos/${repo}/git/trees`, headers, {
    tree: remaining.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha })),
  })

  // 5. Create a new commit
  const newCommit = await request('POST', `${base}/repos/${repo}/git/commits`, headers, {
    message,
    tree: newTree.sha,
    parents: [commitSha],
  })

  // 6. Update the branch ref
  await request('PATCH', `${base}/repos/${repo}/git/refs/heads/${branch}`, headers, {
    sha: newCommit.sha,
    force: false,
  })

  return { ok: true, deleted: treeData.tree.length - remaining.length }
}

/**
 * GitLab: delete a directory in a single commit using the commits API
 * with multiple delete actions in one request.
 */
async function deleteDirectoryGitLab(payload, branch, dirPath, message) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || 'https://gitlab.com'
  const encoded = encodeURIComponent(repo)
  const headers = buildHeaders(payload)

  // List all files under the directory
  const items = await request('GET',
    `${base}/api/v4/projects/${encoded}/repository/tree?path=${encodeURIComponent(dirPath)}&ref=${branch}&recursive=true&per_page=100`,
    headers)
  const files = items.filter((i) => i.type === 'blob')
  if (!files.length) return { ok: true, deleted: 0 }

  // Single commit with all delete actions
  await request('POST', `${base}/api/v4/projects/${encoded}/repository/commits`, headers, {
    branch,
    commit_message: message,
    actions: files.map((f) => ({ action: 'delete', file_path: f.path })),
  })

  return { ok: true, deleted: files.length }
}

/**
 * Gitea: uses the same Git Data API tree approach as GitHub
 * (Gitea mirrors the GitHub API surface).
 */
async function deleteDirectoryGitea(payload, branch, dirPath, message) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || ''
  const headers = buildHeaders(payload)
  const prefix = dirPath.replace(/\/$/, '') + '/'

  // 1. Get current branch commit SHA
  const refData = await request('GET', `${base}/api/v1/repos/${repo}/branches/${branch}`, headers)
  const commitSha = refData.commit.id

  // 2. Get the tree SHA from the commit
  const commitData = await request('GET', `${base}/api/v1/repos/${repo}/git/commits/${commitSha}`, headers)
  const treeSha = commitData.tree?.sha || commitData.commit?.tree?.sha

  // 3. Get the full recursive tree
  const treeData = await request('GET', `${base}/api/v1/repos/${repo}/git/trees/${treeSha}?recursive=true`, headers)
  const remaining = (treeData.tree || []).filter((entry) => !entry.path.startsWith(prefix))

  if (remaining.length === (treeData.tree || []).length) return { ok: true, deleted: 0 }

  // 4-6. Create new tree, commit, update ref
  const newTree = await request('POST', `${base}/api/v1/repos/${repo}/git/trees`, headers, {
    tree: remaining.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha })),
  })
  const newCommit = await request('POST', `${base}/api/v1/repos/${repo}/git/commits`, headers, {
    message,
    tree: newTree.sha,
    parents: [commitSha],
  })
  await request('PATCH', `${base}/api/v1/repos/${repo}/git/refs/heads/${branch}`, headers, {
    sha: newCommit.sha,
    force: false,
  })

  return { ok: true, deleted: (treeData.tree || []).length - remaining.length }
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
    const base = 'https://api.github.com'

    // 1. Confirm repo is accessible
    const repoData = await request('GET', `${base}/repos/${repo}`, headers)

    // 2. Get authenticated user to look up collaborator permission
    //    Fine-grained PATs don't return permissions in the repo response,
    //    so we check the collaborator endpoint instead.
    let canWrite = false
    let canAdmin = false
    let permMethod = 'collaborator API'
    try {
      const userRes = await request('GET', `${base}/user`, headers)
      const username = userRes.login
      if (username) {
        const collabRes = await request('GET', `${base}/repos/${repo}/collaborators/${username}/permission`, headers)
        const level = collabRes.permission // 'admin' | 'write' | 'read' | 'none'
        canWrite = level === 'write' || level === 'admin'
        canAdmin = level === 'admin'
      }
    } catch {
      // Collaborator API may 404 for org repos with restricted visibility —
      // fall back to legacy permissions field if present
      const p = repoData.permissions || {}
      if (Object.keys(p).length > 0) {
        canWrite = Boolean(p.push || p.admin)
        canAdmin = Boolean(p.admin)
        permMethod = 'legacy permissions field'
      } else {
        // Cannot determine — assume write (token works, repo accessible)
        canWrite = true
        permMethod = 'assumed (could not verify)'
      }
    }

    const branches = await getBranches(payload).catch(() => [])
    return {
      ok: true,
      message: `GitHub repository accessible`,
      isEmpty: branches.length === 0,
      permissions: { canRead: true, canWrite, canAdmin },
      details: [
        `Read: yes`,
        `Write (push): ${canWrite ? 'yes' : 'no'}`,
        `Admin: ${canAdmin ? 'yes' : 'no'}`,
        `Permission check: ${permMethod}`,
        ...(!canWrite ? ['⚠ This token cannot push to the repository — deployments will fail'] : []),
      ],
    }
  }

  if (provider === 'gitlab') {
    const base = baseUrl || 'https://gitlab.com'
    const encoded = encodeURIComponent(repo)
    const data = await request('GET', `${base}/api/v4/projects/${encoded}`, headers)
    // access_level: 50=owner, 40=maintainer, 30=developer(push), 20=reporter(read), 10=guest
    const level = data.permissions?.project_access?.access_level
      ?? data.permissions?.group_access?.access_level
      ?? 0
    const canRead  = level >= 20
    const canWrite = level >= 30
    const canAdmin = level >= 40
    const levelLabel = level >= 50 ? 'Owner' : level >= 40 ? 'Maintainer' : level >= 30 ? 'Developer' : level >= 20 ? 'Reporter' : level >= 10 ? 'Guest' : 'None'
    const branches = await getBranches(payload).catch(() => [])
    return {
      ok: true,
      message: `GitLab repository accessible`,
      isEmpty: branches.length === 0,
      permissions: { canRead, canWrite, canAdmin },
      details: [
        `Access level: ${levelLabel} (${level})`,
        `Read: ${canRead ? 'yes' : 'no'}`,
        `Write (push): ${canWrite ? 'yes' : 'no'}`,
        ...(!canWrite ? ['⚠ This token cannot push to the repository — deployments will fail'] : []),
      ],
    }
  }

  // Gitea
  const base = baseUrl || ''
  const data = await request('GET', `${base}/api/v1/repos/${repo}`, headers)
  const p = data.permissions || {}
  const canRead  = true
  const canWrite = Boolean(p.push || p.admin)
  const canAdmin = Boolean(p.admin)
  const branches = await getBranches(payload).catch(() => [])
  return {
    ok: true,
    message: `Gitea repository accessible`,
    isEmpty: branches.length === 0,
    permissions: { canRead, canWrite, canAdmin },
    details: [
      `Read: ${canRead ? 'yes' : 'no'}`,
      `Write (push): ${canWrite ? 'yes' : 'no'}`,
      `Admin: ${canAdmin ? 'yes' : 'no'}`,
      ...(!canWrite ? ['⚠ This token cannot push to the repository — deployments will fail'] : []),
    ],
  }
}

/**
 * Fetch the raw content of a single file from the repo.
 * @param {object} payload  decrypted connection payload
 * @param {string} branch
 * @param {string} filePath
 * @returns {Promise<string>}  raw file content
 */
export async function fetchFile(payload, branch, filePath) {
  const { provider } = payload
  if (provider === 'github') return fetchFileGitHub(payload, branch, filePath)
  if (provider === 'gitlab') return fetchFileGitLab(payload, branch, filePath)
  return fetchFileGitea(payload, branch, filePath)
}

async function fetchFileGitHub(payload, branch, filePath) {
  const { repo } = payload
  const headers = buildHeaders(payload)
  const data = await request('GET', `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`, headers)
  if (!data.content) throw new Error('File content not found in GitHub response')
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
}

async function fetchFileGitLab(payload, branch, filePath) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || 'https://gitlab.com'
  const encoded = encodeURIComponent(repo)
  const encodedPath = encodeURIComponent(filePath)
  const headers = buildHeaders(payload)
  const data = await request('GET', `${base}/api/v4/projects/${encoded}/repository/files/${encodedPath}?ref=${branch}`, headers)
  if (!data.content) throw new Error('File content not found in GitLab response')
  return Buffer.from(data.content, 'base64').toString('utf8')
}

async function fetchFileGitea(payload, branch, filePath) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || ''
  const headers = buildHeaders(payload)
  const data = await request('GET', `${base}/api/v1/repos/${repo}/contents/${filePath}?ref=${branch}`, headers)
  if (!data.content) throw new Error('File content not found in Gitea response')
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
}
