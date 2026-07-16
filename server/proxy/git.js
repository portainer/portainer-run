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
    const base = githubApiBase(payload)
    const data = await request('GET', `${base}/repos/${repo}/branches`, headers)
    return data.map((b) => b.name)
  }
  if (provider === 'gitlab') {
    const base = gitlabApiBase(payload)
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
    const base = githubApiBase(payload)
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
    const base = gitlabApiBase(payload)
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
  const base = githubApiBase(payload)

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
  } catch (e) {
    // Only treat "not found" / empty-repo responses as "start from scratch".
    // Re-throw everything else (rate limits, auth failures, network errors)
    // so a transient GET failure cannot silently replace the entire branch tree.
    const msg = (e?.message || '').toLowerCase()
    if (!msg.includes('not found') && !msg.includes('git repository is empty')) throw e
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
  const { repo } = payload
  const base = gitlabApiBase(payload)
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

/**
 * GitHub REST API base URL for a connection.
 * - github.com (no url): https://api.github.com
 * - GitHub Enterprise Server (url set): https://<host>/api/v3
 * @param {object} payload
 * @returns {string}
 */
function githubApiBase(payload) {
  const url = (payload.url || '').trim().replace(/\/+$/, '')
  if (!url) return 'https://api.github.com'
  // Accept either the web host (https://ghe.example.com) or a full
  // api base already ending in /api/v3.
  if (/\/api\/v3$/.test(url)) return url
  return `${url}/api/v3`
}

/**
 * GitLab host base URL for a connection.
 * - gitlab.com (no url): https://gitlab.com
 * - Self-hosted GitLab (url set): https://<host> (trailing slash trimmed)
 * The /api/v4 path is appended by each call site.
 * @param {object} payload
 * @returns {string}
 */
function gitlabApiBase(payload) {
  const url = (payload.url || '').trim().replace(/\/+$/, '')
  return url || 'https://gitlab.com'
}

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
          // Provider bodies (e.g. GitHub's `{"message":"Not Found"}`) are terse
          // and drop the request context, so fold the method/host/path/status
          // into the message. Only the pathname is logged — never headers/query,
          // which can carry credentials.
          let detail = ''
          try { detail = JSON.parse(text)?.message || '' } catch { /* ignore */ }
          const err = new Error(
            `git ${method} ${u.host}${u.pathname} → HTTP ${res.statusCode}` +
              (detail ? `: ${detail}` : ''),
          )
          err.status = res.statusCode
          err.method = method
          err.url = `${u.origin}${u.pathname}`
          return reject(err)
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
  const base = githubApiBase(payload)

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
  const { repo } = payload
  const base = gitlabApiBase(payload)
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
 * Delete multiple paths (a mix of files and directories) in a SINGLE commit.
 *
 * Doing file + directory removals as separate commits races GitHub's
 * read-after-write ref propagation: the second operation can read a stale
 * branch SHA and fail the ref update with a non-fast-forward error. Removing
 * everything in one commit closes that window entirely.
 *
 * @param {object} payload
 * @param {string} branch
 * @param {string[]} paths   file paths and/or directory paths to remove
 * @param {string} message
 */
export async function deletePaths(payload, branch, paths, message) {
  const clean = (paths || []).map((p) => String(p || '').replace(/\/+$/, '')).filter(Boolean)
  if (clean.length === 0) return { ok: true, deleted: 0 }
  const { provider } = payload
  if (provider === 'github') return deletePathsGitHub(payload, branch, clean, message)
  if (provider === 'gitlab') return deletePathsGitLab(payload, branch, clean, message)
  return deletePathsGitea(payload, branch, clean, message)
}

/** True when a blob path should be removed given the requested paths. */
function matchesAnyPath(blobPath, paths) {
  for (const p of paths) {
    // Exact file match, or any blob under a directory prefix.
    if (blobPath === p || blobPath.startsWith(p + '/')) return true
  }
  return false
}

/**
 * GitHub: remove all requested files and directory subtrees in one commit
 * using the Git Data API (ref → commit → tree → new tree → new commit → ref).
 */
async function deletePathsGitHub(payload, branch, paths, message) {
  const { repo } = payload
  const headers = buildHeaders(payload)
  const base = githubApiBase(payload)

  const refData = await request('GET', `${base}/repos/${repo}/git/ref/heads/${branch}`, headers)
  const commitSha = refData.object.sha
  const commitData = await request('GET', `${base}/repos/${repo}/git/commits/${commitSha}`, headers)
  const treeSha = commitData.tree.sha
  const treeData = await request('GET', `${base}/repos/${repo}/git/trees/${treeSha}?recursive=1`, headers)

  const allBlobs = treeData.tree.filter((e) => e.type === 'blob')
  const remaining = allBlobs.filter((entry) => !matchesAnyPath(entry.path, paths))
  if (remaining.length === allBlobs.length) return { ok: true, deleted: 0 }

  const newTree = await request('POST', `${base}/repos/${repo}/git/trees`, headers, {
    tree: remaining.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha })),
  })
  const newCommit = await request('POST', `${base}/repos/${repo}/git/commits`, headers, {
    message,
    tree: newTree.sha,
    parents: [commitSha],
  })
  await request('PATCH', `${base}/repos/${repo}/git/refs/heads/${branch}`, headers, {
    sha: newCommit.sha,
    force: false,
  })
  return { ok: true, deleted: allBlobs.length - remaining.length }
}

/**
 * GitLab: one commits API call with a delete action per resolved file. Files
 * are resolved by listing each directory path recursively; explicit file paths
 * are included directly.
 */
async function deletePathsGitLab(payload, branch, paths, message) {
  const { repo } = payload
  const base = gitlabApiBase(payload)
  const encoded = encodeURIComponent(repo)
  const headers = buildHeaders(payload)

  const fileSet = new Set()
  for (const p of paths) {
    // Try to list p as a directory; if it yields blobs, those are the targets.
    let listed = []
    try {
      listed = await request('GET',
        `${base}/api/v4/projects/${encoded}/repository/tree?path=${encodeURIComponent(p)}&ref=${branch}&recursive=true&per_page=100`,
        headers)
    } catch { listed = [] }
    const blobs = (Array.isArray(listed) ? listed : []).filter((i) => i.type === 'blob')
    if (blobs.length > 0) {
      for (const b of blobs) fileSet.add(b.path)
    } else {
      // Not a directory (or empty) — treat as a single file path.
      fileSet.add(p)
    }
  }
  if (fileSet.size === 0) return { ok: true, deleted: 0 }

  await request('POST', `${base}/api/v4/projects/${encoded}/repository/commits`, headers, {
    branch,
    commit_message: message,
    actions: [...fileSet].map((file_path) => ({ action: 'delete', file_path })),
  })
  return { ok: true, deleted: fileSet.size }
}

/**
 * Gitea: same single-commit Git Data API approach as GitHub.
 */
async function deletePathsGitea(payload, branch, paths, message) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || ''
  const headers = buildHeaders(payload)

  const refData = await request('GET', `${base}/api/v1/repos/${repo}/branches/${branch}`, headers)
  const commitSha = refData.commit.id
  const commitData = await request('GET', `${base}/api/v1/repos/${repo}/git/commits/${commitSha}`, headers)
  const treeSha = commitData.tree?.sha || commitData.commit?.tree?.sha
  const treeData = await request('GET', `${base}/api/v1/repos/${repo}/git/trees/${treeSha}?recursive=true`, headers)

  const allBlobs = (treeData.tree || []).filter((e) => e.type === 'blob')
  const remaining = allBlobs.filter((entry) => !matchesAnyPath(entry.path, paths))
  if (remaining.length === allBlobs.length) return { ok: true, deleted: 0 }

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
  return { ok: true, deleted: allBlobs.length - remaining.length }
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
  const base = githubApiBase(payload)
  const prefix = dirPath.replace(/\/$/, '') + '/'

  // 1. Get current branch commit SHA
  const refData = await request('GET', `${base}/repos/${repo}/git/ref/heads/${branch}`, headers)
  const commitSha = refData.object.sha

  // 2. Get the current commit to find the tree SHA and parent
  const commitData = await request('GET', `${base}/repos/${repo}/git/commits/${commitSha}`, headers)
  const treeSha = commitData.tree.sha

  // 3. Get the full recursive tree
  const treeData = await request('GET', `${base}/repos/${repo}/git/trees/${treeSha}?recursive=1`, headers)

  // Only keep blob (file) entries — Git reconstructs tree (directory) objects automatically.
  // Keeping stale tree-type entries would pass old tree SHAs that still contain the deleted files.
  const allBlobs = treeData.tree.filter((e) => e.type === 'blob')
  const remaining = allBlobs.filter((entry) => !entry.path.startsWith(prefix))

  if (remaining.length === allBlobs.length) return { ok: true, deleted: 0 } // nothing to delete

  // 4. Create a new tree with only the remaining blob entries
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
  const { repo } = payload
  const base = gitlabApiBase(payload)
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
  const allBlobs = (treeData.tree || []).filter((e) => e.type === 'blob')
  const remaining = allBlobs.filter((entry) => !entry.path.startsWith(prefix))

  if (remaining.length === allBlobs.length) return { ok: true, deleted: 0 }

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
  if (provider === 'github') {
    const host = (baseUrl || '').trim().replace(/\/+$/, '').replace(/\/api\/v3$/, '')
    return host ? `${host}/${repo}` : `https://github.com/${repo}`
  }
  if (provider === 'gitlab') {
    const base = gitlabApiBase(payload)
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
    const base = githubApiBase(payload)

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
    const base = gitlabApiBase(payload)
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
  const base = githubApiBase(payload)
  const data = await request('GET', `${base}/repos/${repo}/contents/${filePath}?ref=${branch}`, headers)
  if (!data.content) throw new Error('File content not found in GitHub response')
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
}

async function fetchFileGitLab(payload, branch, filePath) {
  const { repo } = payload
  const base = gitlabApiBase(payload)
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

// ---------------------------------------------------------------------------
// List files — returns flat array of filenames at a given path in a repo.
// Used by Vibe Deploy "Source from Git" to detect the runtime.
// ---------------------------------------------------------------------------

/**
 * Returns a flat list of { path, type } entries under dirPath.
 * @param {object} payload
 * @param {string} branch
 * @param {string} dirPath  empty string or '/' for repo root
 * @returns {Promise<Array<{ path: string, type: 'file'|'dir' }>>}
 */
export async function listFiles(payload, branch, dirPath = '') {
  const { provider } = payload
  if (provider === 'github') return listFilesGitHubFlat(payload, branch, dirPath)
  if (provider === 'gitlab') return listFilesGitLabFlat(payload, branch, dirPath)
  return listFilesGiteaFlat(payload, branch, dirPath)
}

async function listFilesGitHubFlat(payload, branch, dirPath) {
  const { repo } = payload
  const headers = buildHeaders(payload)
  const base = githubApiBase(payload)
  const pathSeg = dirPath ? `/${dirPath.replace(/^\/|\/$/g, '')}` : ''
  try {
    const data = await request('GET', `${base}/repos/${repo}/contents${pathSeg}?ref=${branch}`, headers)
    if (!Array.isArray(data)) return []
    return data.map((e) => ({ path: e.name, type: e.type === 'dir' ? 'dir' : 'file' }))
  } catch {
    return []
  }
}

async function listFilesGitLabFlat(payload, branch, dirPath) {
  const { repo } = payload
  const base = gitlabApiBase(payload)
  const encoded = encodeURIComponent(repo)
  const headers = buildHeaders(payload)
  const pathParam = dirPath ? `&path=${encodeURIComponent(dirPath.replace(/^\/|\/$/g, ''))}` : ''
  try {
    const items = await request('GET', `${base}/api/v4/projects/${encoded}/repository/tree?ref=${branch}${pathParam}&per_page=100`, headers)
    if (!Array.isArray(items)) return []
    return items.map((e) => ({ path: e.name, type: e.type === 'tree' ? 'dir' : 'file' }))
  } catch {
    return []
  }
}

async function listFilesGiteaFlat(payload, branch, dirPath) {
  const { repo, url: baseUrl } = payload
  const base = baseUrl || ''
  const headers = buildHeaders(payload)
  const pathSeg = dirPath ? `/${dirPath.replace(/^\/|\/$/g, '')}` : ''
  try {
    const data = await request('GET', `${base}/api/v1/repos/${repo}/contents${pathSeg}?ref=${branch}`, headers)
    if (!Array.isArray(data)) return []
    return data.map((e) => ({ path: e.name, type: e.type === 'dir' ? 'dir' : 'file' }))
  } catch {
    return []
  }
}
