import { readBody } from '../lib/http.js'
import { CORS } from '../lib/cors.js'
import { resolvePortainerTarget } from '../resolve-portainer.js'
import { extractToken } from '../lib/identity.js'
import https from 'node:https'
import http from 'node:http'

/**
 * POST /api/helm/deploy
 * Proxies a Helm chart deployment to Portainer's Helm stack API.
 * Body: { envId, namespace, releaseName, chart, repo, version, values }
 */
export async function handleHelm(req, res, pathname) {
  if (pathname === '/api/helm/deploy' && req.method === 'POST') {
    return handleHelmDeploy(req, res)
  }
  return null
}

async function handleHelmDeploy(req, res) {
  if (!extractToken(req)) {
    return json(res, 401, { error: 'Unauthorized' })
  }

  const body = await readBody(req)
  const data = parseJson(body)
  if (!data) return json(res, 400, { error: 'Invalid request body' })

  const { envId, namespace, releaseName, chart, repo, version, values } = data
  if (!envId || !namespace || !releaseName || !chart || !repo) {
    return json(res, 400, { error: 'envId, namespace, releaseName, chart and repo are required' })
  }

  const target = resolvePortainerTarget(req)
  if (!target) return json(res, 400, { error: 'Cannot resolve Portainer target' })

  const userToken = extractToken(req)

  const helmBody = JSON.stringify({
    Name: releaseName,
    Chart: chart,
    Repo: repo,
    Version: version || '',
    Values: values || '',
    Namespace: namespace,
  })

  try {
    const result = await portainerRequest(
      target,
      userToken,
      'POST',
      `/api/endpoints/${envId}/kubernetes/helm`,
      helmBody,
    )
    return json(res, 200, { ok: true, result })
  } catch (err) {
    console.error('[helm deploy error]', err.message)
    return json(res, 502, { error: err.message })
  }
}

function portainerRequest(target, userToken, method, path, body) {
  return new Promise((resolve, reject) => {
    const transport = target.isHttps ? https : http
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
    if (userToken) headers['Cookie'] = `portainer_api_key=${userToken}`
    if (body) headers['Content-Length'] = Buffer.byteLength(body)

    const opts = {
      hostname: target.host,
      port: target.port,
      path,
      method,
      headers,
      rejectUnauthorized: false,
    }

    const reqOut = transport.request(opts, (upRes) => {
      const chunks = []
      upRes.on('data', (c) => chunks.push(c))
      upRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (upRes.statusCode >= 400) {
          let msg = `Portainer API HTTP ${upRes.statusCode}`
          try { msg = JSON.parse(text)?.message || msg } catch { /* ignore */ }
          return reject(new Error(msg))
        }
        try { resolve(JSON.parse(text)) } catch { resolve(text) }
      })
    })
    reqOut.on('error', reject)
    if (body) reqOut.write(body)
    reqOut.end()
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

function parseJson(body) {
  if (!body || !body.length) return null
  try { return JSON.parse(body.toString('utf8')) } catch { return null }
}
