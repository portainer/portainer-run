/**
 * Portainer Run — CORS proxy + Anthropic relay + session cache
 *
 * Responsibilities:
 *  1. Serve HTTPS (443 by default) with self-signed or real certs
 *  2. Redirect HTTP (80) → HTTPS
 *  3. Proxy /portainer-api/* → Portainer (CORS bypass, user token passed through)
 *  4. Proxy /ai/triage → Anthropic API (key stored server-side, never in browser)
 *  5. File-backed session cache keyed by hashed PAT (/cache GET/POST/DELETE)
 *     Default path: /app/data/cache.json — mount /app/data as a volume to persist
 *     across container restarts, or set CACHE_DIR to an external path.
 *
 * .env config:
 *   PORTAINER_URL=https://portainer.example.com:9443   (required)
 *   ANTHROPIC_API_KEY=sk-ant-...                        (optional, enables AI triage)
 *   PORT=443                                            (optional, default 443)
 *   HTTP_PORT=80                                        (optional, default 80)
 *   SSL_CERT=/path/to/fullchain.pem                     (optional, uses self-signed if not set)
 *   SSL_KEY=/path/to/privkey.pem                        (optional, uses self-signed if not set)
 *   SSL_CERT_DIR=/certs                                 (optional, dir for self-signed cert storage)
 *   CACHE_DIR=/app/data                                 (optional, dir for cache.json)
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');
const cp      = require('child_process');
const crypto  = require('crypto');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => {
      const [k, ...v] = l.split('=');
      if (k && !process.env[k.trim()]) {
        process.env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
      }
    });
}

const PORTAINER_URL = (process.env.PORTAINER_URL || '').replace(/\/$/, '');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY    = process.env.OPENAI_API_KEY    || '';
const AI_PROVIDER   = process.env.AI_PROVIDER       || (ANTHROPIC_KEY ? 'anthropic' : OPENAI_KEY ? 'openai' : '');
const OPENAI_MODEL  = process.env.OPENAI_MODEL      || 'gpt-4o';
// OPENAI_BASE_URL lets users point at any OpenAI-compatible endpoint:
// Ollama (http://host.docker.internal:11434/v1), vLLM, OpenRouter,
// LM Studio, Azure OpenAI, etc. Defaults to OpenAI Cloud.
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_ORIGIN   = new url.URL(OPENAI_BASE_URL);
const PORT          = parseInt(process.env.PORT      || '443');
const HTTP_PORT     = parseInt(process.env.HTTP_PORT || '80');
const SSL_CERT_PATH = process.env.SSL_CERT     || '';
const SSL_KEY_PATH  = process.env.SSL_KEY      || '';
const CERT_DIR      = process.env.SSL_CERT_DIR || __dirname;
const CACHE_DIR     = process.env.CACHE_DIR    || path.join(__dirname, 'data');
const TEMPLATE_URL  = process.env.TEMPLATE_URL || 'https://raw.githubusercontent.com/portainer/portainer-run/refs/heads/develop/templates.json';
const BASE_DOMAIN   = process.env.BASE_DOMAIN  || '';
const CACHE_FILE    = path.join(CACHE_DIR, 'cache.json');

if (!PORTAINER_URL) {
  console.error('\n❌  PORTAINER_URL must be set\n');
  process.exit(1);
}
if (!ANTHROPIC_KEY && !OPENAI_KEY) {
  console.warn('\n⚠️   No AI key set (ANTHROPIC_API_KEY or OPENAI_API_KEY) — AI triage will be unavailable\n');
}

try { new URL(PORTAINER_URL); } catch(_) {
  console.error(`\n❌  Invalid PORTAINER_URL: "${PORTAINER_URL}"\n`);
  process.exit(1);
}

const pOrigin  = new URL(PORTAINER_URL);
const pIsHttps = pOrigin.protocol === 'https:';
const pHost    = pOrigin.hostname;
const pPort    = pOrigin.port ? parseInt(pOrigin.port) : (pIsHttps ? 443 : 80);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key,Authorization',
};

// ── FILE-BACKED SESSION CACHE ─────────────────────────────────────────────────
// Keyed by SHA-256 hash of the user's PAT.
// Cleared on disconnect (DELETE /cache). Persists across container restarts
// if CACHE_DIR is mounted as an external volume.

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCacheFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch(_) {}
  return {};
}

// Atomic write via tmp-file + rename (rename is atomic on POSIX). Prevents a
// crash mid-write from leaving a truncated/partial cache.json that breaks the
// next JSON.parse.
function writeCacheFile(data) {
  const tmp = CACHE_FILE + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch(e) {
    console.warn('[cache] write failed:', e.message);
    try { fs.unlinkSync(tmp); } catch(_) {}
  }
}

// Serialise read-modify-write cycles so two concurrent POSTs/DELETEs don't
// drop one another's update. The in-process queue is sufficient because only
// this one server process owns the file. If we ever run multiple replicas
// against a shared cache volume we'd need flock or an external store.
let cacheMutation = Promise.resolve();
function mutateCache(fn) {
  const next = cacheMutation.then(() => fn(readCacheFile())).then(data => {
    if (data !== undefined) writeCacheFile(data);
  });
  // Swallow errors on the chain so one bad mutation doesn't poison future ones.
  cacheMutation = next.catch(() => {});
  return next;
}

function handleCache(req, res) {
  const token = req.headers['x-api-key'] || '';
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'X-API-Key header required' }));
    return;
  }
  const key = cacheKey(token);

  if (req.method === 'GET') {
    const all   = readCacheFile();
    const entry = all[key] || null;
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(entry));
    return;
  }

  if (req.method === 'POST') {
    readBody(req).then(body => {
      let data;
      try { data = JSON.parse(body.toString()); }
      catch(_) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      mutateCache(all => {
        all[key] = { ...data, savedAt: Date.now() };
        return all;
      }).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  if (req.method === 'DELETE') {
    mutateCache(all => { delete all[key]; return all; }).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(405, CORS);
  res.end();
}


// ── ENVIRONMENT STATUS AGGREGATOR ────────────────────────────────────────────
// Single server-side endpoint that fans out to Kubernetes for one environment,
// aggregates pods + services + ingresses + nodes into a per-deployment status
// map, and caches the result for STATUS_TTL ms.
//
// Browser fires one request per environment instead of 3× per deployment.
// At scale: 50 envs × 200 apps = 50 browser calls instead of ~600.

const STATUS_TTL = 20 * 1000; // 20 seconds

// statusCache[cacheKey] = { data, expiresAt }
const statusCache = new Map();

// Concurrency limiter — prevent server from fan-out flooding Portainer
function limit(concurrency) {
  let active = 0;
  const queue = [];
  return function run(fn) {
    return new Promise((resolve, reject) => {
      const next = () => {
        if (!queue.length) return;
        if (active >= concurrency) return;
        active++;
        const { fn: f, resolve: res, reject: rej } = queue.shift();
        Promise.resolve().then(f).then(v => { active--; res(v); next(); }).catch(e => { active--; rej(e); next(); });
      };
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}
const kubeLimit = limit(10); // max 10 concurrent kube calls per server process

// Make a proxied call to Portainer's Kubernetes API server-side
function kubeCall(token, envId, kubePath) {
  return kubeLimit(() => new Promise((resolve, reject) => {
    const upPath = `/api/endpoints/${envId}/kubernetes${kubePath}`;
    const headers = {
      'Accept': 'application/json',
      'X-API-Key': token,
    };
    const opts = {
      hostname: pHost, port: pPort, path: upPath,
      method: 'GET', headers, rejectUnauthorized: false,
    };
    const transport = pIsHttps ? https : http;
    const req = transport.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch(_) {
          resolve({ status: res.statusCode, body: {} });
        }
      });
    });
    req.on('error', reject);
    req.end();
  }));
}

// Plain-English reason from pod state — mirrors the frontend logic
function resolveStatusReason(pod) {
  const scheduledCond = (pod.status?.conditions || []).find(c => c.type === 'PodScheduled');
  if (scheduledCond?.status === 'False') {
    const msg = (scheduledCond.message || '').toLowerCase();
    if (msg.includes('nvidia.com/gpu') || msg.includes('amd.com/gpu') || msg.includes('gpu.intel.com') || msg.includes('insufficient gpu'))
      return 'No GPU node available';
    if (msg.includes('insufficient cpu') || msg.includes('insufficient memory') || msg.includes('nodes are available'))
      return 'No node has enough resources';
    if (msg.includes('node selector') || msg.includes('affinity') || msg.includes('taint') || msg.includes("didn't match") || msg.includes('tolerat'))
      return 'No compatible node found';
    return 'Cannot be scheduled';
  }
  const allCS = [...(pod.status?.containerStatuses || []), ...(pod.status?.initContainerStatuses || [])];
  if (pod.status?.phase === 'Pending' && !allCS.length) return 'Waiting for a node';
  for (const cs of allCS) {
    const waiting = cs.state?.waiting;
    const terminated = cs.state?.terminated;
    const restarts = cs.restartCount || 0;
    if (waiting?.reason) {
      switch (waiting.reason) {
        case 'ImagePullBackOff': case 'ErrImagePull': return "Can't download the image";
        case 'InvalidImageName':                      return 'Image name is invalid';
        case 'CrashLoopBackOff':                      return `App keeps crashing (${restarts} restart${restarts !== 1 ? 's' : ''})`;
        case 'CreateContainerError': case 'RunContainerError': return 'Failed to start the container';
        case 'CreateContainerConfigError':            return 'Missing config or secret';
        case 'ContainerCreating':                     return null;
        default:                                      return waiting.reason;
      }
    }
    if (terminated) {
      if (terminated.reason === 'OOMKilled' && restarts >= 3)  return `Hitting memory limit (${restarts} restart${restarts !== 1 ? 's' : ''})`;
      if (terminated.exitCode > 0 && restarts >= 3)            return `Exiting with errors (${restarts} restart${restarts !== 1 ? 's' : ''})`;
    }
  }
  return null;
}

// Resolve a clickable URL from services + ingresses for a given app label
function resolveUrl(appName, svcs, ings, nodeIp) {
  // Ingress — FQDN with scheme
  for (const ing of ings.filter(i => i.metadata?.labels?.app === appName || (i.spec?.rules || []).length)) {
    for (const rule of (ing.spec?.rules || [])) {
      const host = rule.host;
      if (!host) continue;
      const tls = ing.spec?.tls?.some(t => !t.hosts || t.hosts.includes(host));
      const scheme = tls ? 'https' : 'http';
      const path = rule.http?.paths?.[0]?.path || '/';
      return { url: `${scheme}://${host}${path === '/' ? '' : path}`, label: host, type: 'ingress' };
    }
  }
  // LoadBalancer — IP:port only
  for (const svc of svcs.filter(s => s.spec?.type === 'LoadBalancer' && (s.metadata?.labels?.app === appName || s.metadata?.name === appName))) {
    const ing = svc.status?.loadBalancer?.ingress?.[0];
    const external = ing?.ip || ing?.hostname;
    const port = svc.spec?.ports?.[0]?.port;
    if (external) {
      return { url: `http://${external}:${port}`, label: `${external}:${port}`, type: 'lb' };
    }
    return { url: null, label: 'Pending', type: 'lb' };
  }
  // NodePort — node IP:nodePort only
  for (const svc of svcs.filter(s => s.spec?.type === 'NodePort' && (s.metadata?.labels?.app === appName || s.metadata?.name === appName))) {
    const nodePort = svc.spec?.ports?.[0]?.nodePort;
    if (nodePort && nodeIp) {
      return { url: `http://${nodeIp}:${nodePort}`, label: `${nodeIp}:${nodePort}`, type: 'nodeport' };
    }
    if (nodePort) return { url: null, label: `:${nodePort}`, type: 'nodeport' };
  }
  return null;
}

async function buildEnvStatus(token, envId) {
  // Fan out all queries in parallel
  const [podsR, svcsR, ingsR, nodesR] = await Promise.all([
    kubeCall(token, envId, '/api/v1/pods?labelSelector=' + encodeURIComponent('managed-by=portainer-run')),
    kubeCall(token, envId, '/api/v1/services?labelSelector=' + encodeURIComponent('managed-by=portainer-run')),
    kubeCall(token, envId, '/apis/networking.k8s.io/v1/ingresses?labelSelector=' + encodeURIComponent('managed-by=portainer-run')),
    kubeCall(token, envId, '/api/v1/nodes'),
  ]);

  const pods  = podsR.status === 200  ? (podsR.body.items  || []) : [];
  const svcs  = svcsR.status === 200  ? (svcsR.body.items  || []) : [];
  const ings  = ingsR.status === 200  ? (ingsR.body.items  || []) : [];
  const nodes = nodesR.status === 200 ? (nodesR.body.items || []) : [];

  // Resolve node IP once
  let nodeIp = null;
  for (const node of nodes) {
    const addrs = node.status?.addresses || [];
    const ext = addrs.find(a => a.type === 'ExternalIP');
    const int = addrs.find(a => a.type === 'InternalIP');
    nodeIp = ext?.address || int?.address;
    if (nodeIp) break;
  }

  // Group pods by app label
  const podsByApp = {};
  for (const pod of pods) {
    const app = pod.metadata?.labels?.app;
    if (!app) continue;
    (podsByApp[app] = podsByApp[app] || []).push(pod);
  }

  // Build result map: appName → { statusReason, accessUrl, accessLabel }
  const result = {};
  const appNames = new Set([
    ...Object.keys(podsByApp),
    ...svcs.map(s => s.metadata?.labels?.app).filter(Boolean),
  ]);

  for (const appName of appNames) {
    const appPods = podsByApp[appName] || [];
    let statusReason = null;
    for (const pod of appPods) {
      statusReason = resolveStatusReason(pod);
      if (statusReason) break;
    }
    const access = resolveUrl(appName, svcs, ings, nodeIp);
    result[appName] = {
      statusReason,
      accessUrl:   access?.url   || null,
      accessLabel: access?.label || null,
    };
  }

  return result;
}

async function handleEnvStatus(req, res, envId) {
  if (req.method !== 'GET') { res.writeHead(405, CORS); res.end(); return; }
  const token = req.headers['x-api-key'] || '';
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'X-API-Key required' }));
    return;
  }
  // Cache key includes token hash + envId so users don't see each other's data
  const ck = crypto.createHash('sha256').update(token + ':' + envId).digest('hex');
  const now = Date.now();
  const cached = statusCache.get(ck);
  if (cached && cached.expiresAt > now) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ cached: true, data: cached.data }));
    return;
  }
  try {
    const data = await buildEnvStatus(token, envId);
    statusCache.set(ck, { data, expiresAt: now + STATUS_TTL });
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ cached: false, data }));
  } catch(e) {
    console.error(`[env-status] env=${envId}`, e.message);
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// Prune expired status cache entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of statusCache) {
    if (v.expiresAt < now) statusCache.delete(k);
  }
}, 2 * 60 * 1000);

// ── TEMPLATE CATALOGUE ────────────────────────────────────────────────────────
// Fetches the template catalogue from TEMPLATE_URL, caches it in memory for
// 5 minutes, and serves it via /templates. The browser never makes a
// cross-origin request to GitHub directly.

let templateCache = null;
let templateCacheTime = 0;
const TEMPLATE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchTemplates() {
  const now = Date.now();
  if (templateCache && (now - templateCacheTime) < TEMPLATE_CACHE_TTL) {
    return templateCache;
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(TEMPLATE_URL);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get(TEMPLATE_URL, { headers: { 'User-Agent': 'portainer-run/1.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const data = JSON.parse(body);
          templateCache = data;
          templateCacheTime = Date.now();
          resolve(data);
        } catch(e) {
          reject(new Error('Failed to parse templates: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function handleTemplates(req, res) {
  if (req.method !== 'GET') { res.writeHead(405, CORS); res.end(); return; }
  fetchTemplates()
    .then(data => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(data));
    })
    .catch(e => {
      console.error('[templates]', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Could not load templates', message: e.message }));
    });
}

// ── TLS CERT SETUP ────────────────────────────────────────────────────────────
function ensureSelfSignedCert(certFile, keyFile) {
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) return;
  console.log('🔐  Generating self-signed certificate (3 year validity)...');
  try {
    cp.execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes` +
      ` -keyout "${keyFile}"` +
      ` -out "${certFile}"` +
      ` -days 1095` +
      ` -subj "/CN=portainer-run"` +
      ` -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
      { stdio: 'pipe' }
    );
    console.log('✅  Self-signed certificate generated');
  } catch(e) {
    console.error('❌  Failed to generate self-signed cert:', e.message);
    process.exit(1);
  }
}

function loadTlsOptions() {
  if (SSL_CERT_PATH && SSL_KEY_PATH) {
    if (!fs.existsSync(SSL_CERT_PATH)) { console.error(`\n❌  SSL_CERT not found: ${SSL_CERT_PATH}\n`); process.exit(1); }
    if (!fs.existsSync(SSL_KEY_PATH))  { console.error(`\n❌  SSL_KEY not found: ${SSL_KEY_PATH}\n`);  process.exit(1); }
    console.log('🔐  Using provided TLS certificates');
    return { cert: fs.readFileSync(SSL_CERT_PATH), key: fs.readFileSync(SSL_KEY_PATH) };
  }
  const certFile = path.join(CERT_DIR, 'portainer-run.crt');
  const keyFile  = path.join(CERT_DIR, 'portainer-run.key');
  ensureSelfSignedCert(certFile, keyFile);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}

function proxyToPortainer(req, res, upstreamPath, body) {
  const userToken = req.headers['x-api-key'] || '';
  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'Accept': 'application/json',
  };
  if (userToken) headers['X-API-Key'] = userToken;
  if (body && body.length) headers['Content-Length'] = body.length;

  const opts = {
    hostname: pHost, port: pPort, path: upstreamPath,
    method: req.method, headers, rejectUnauthorized: false,
  };
  const transport = pIsHttps ? https : http;
  const upstream = transport.request(opts, upRes => {
    const resHeaders = { ...CORS, 'Content-Type': upRes.headers['content-type'] || 'application/json' };
    if (upRes.headers['content-encoding']) resHeaders['Content-Encoding'] = upRes.headers['content-encoding'];
    res.writeHead(upRes.statusCode, resHeaders);
    upRes.pipe(res);
  });
  upstream.on('error', e => {
    console.error('[portainer proxy error]', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'Proxy error', message: e.message }));
  });
  if (body && body.length) upstream.write(body);
  upstream.end();
}

function proxyToAnthropic(req, res, body) {
  if (!ANTHROPIC_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on server' }));
    return;
  }
  let payload;
  try { payload = JSON.parse(body.toString()); } catch(_) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }
  const outBody = Buffer.from(JSON.stringify(payload));
  const headers = {
    'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01', 'Content-Length': outBody.length,
  };
  const upstream = https.request(
    { hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST', headers },
    upRes => {
      res.writeHead(upRes.statusCode, {
        ...CORS,
        'Content-Type':  upRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      upRes.pipe(res);
    }
  );
  upstream.on('error', e => {
    console.error('[anthropic proxy error]', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  upstream.write(outBody);
  upstream.end();
}

// ── OPENAI PROXY ─────────────────────────────────────────────────────────────
// Translates Anthropic-format requests → OpenAI, streams back in Anthropic SSE
// format so the frontend works unchanged regardless of provider.

function proxyToOpenAI(req, res, body) {
  if (!OPENAI_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'OPENAI_API_KEY not configured on server' }));
    return;
  }
  let payload;
  try { payload = JSON.parse(body.toString()); } catch(_) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  // Translate Anthropic format to OpenAI format
  const messages = [];
  if (payload.system) messages.push({ role: 'system', content: payload.system });
  (payload.messages || []).forEach(m => messages.push({ role: m.role, content: m.content }));

  const openaiPayload = {
    model: OPENAI_MODEL,
    max_tokens: payload.max_tokens || 1000,
    stream: !!payload.stream,
    messages,
  };

  const outBody = Buffer.from(JSON.stringify(openaiPayload));
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + OPENAI_KEY,
    'Content-Length': outBody.length,
  };

  const oaiIsHttps = OPENAI_ORIGIN.protocol === 'https:';
  const oaiPort    = OPENAI_ORIGIN.port ? parseInt(OPENAI_ORIGIN.port) : (oaiIsHttps ? 443 : 80);
  const oaiPath    = OPENAI_ORIGIN.pathname.replace(/\/$/, '') + '/chat/completions';
  const oaiTransport = oaiIsHttps ? https : http;
  const upstream = oaiTransport.request(
    { hostname: OPENAI_ORIGIN.hostname, port: oaiPort, path: oaiPath, method: 'POST', headers },
    upRes => {
      if (!openaiPayload.stream) {
        // Non-streaming: translate OpenAI response to Anthropic format
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          try {
            const oai = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const text = oai.choices && oai.choices[0] && oai.choices[0].message && oai.choices[0].message.content || '';
            const anthropicResp = {
              id: oai.id || 'msg_openai',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text }],
              model: OPENAI_MODEL,
              stop_reason: 'end_turn',
              usage: { input_tokens: oai.usage && oai.usage.prompt_tokens || 0, output_tokens: oai.usage && oai.usage.completion_tokens || 0 },
            };
            const respBody = Buffer.from(JSON.stringify(anthropicResp));
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': respBody.length, ...CORS });
            res.end(respBody);
          } catch(e) {
            res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
            res.end(JSON.stringify({ error: 'Failed to parse OpenAI response' }));
          }
        });
      } else {
        // Streaming: translate OpenAI SSE to Anthropic SSE format
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS });
        res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_openai","type":"message","role":"assistant","content":[],"model":"${OPENAI_MODEL}"}}\n\n`);
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        let buffer = '';
        upRes.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
              res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
              res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const text = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
              if (text) {
                const evt = JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
                res.write('event: content_block_delta\ndata: ' + evt + '\n\n');
              }
            } catch(_) {}
          }
        });
        upRes.on('end', () => { try { res.end(); } catch(_) {} });
      }
    }
  );
  upstream.on('error', e => {
    console.error('[openai proxy error]', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  upstream.write(outBody);
  upstream.end();
}

// Validate the X-API-Key against Portainer. Caller must supply a valid Portainer
// PAT — without this check anyone reachable at /ai/triage could burn the
// server's AI credits. Positive results are cached for AUTH_CACHE_TTL_MS so we
// don't round-trip to Portainer on every AI request; negatives are not cached
// so rotated/revoked tokens get a fresh check next time.
const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map();       // sha256(token) → expiresAt (ms)

function validatePortainerToken(token) {
  const key = cacheKey(token);
  const now = Date.now();
  const exp = authCache.get(key);
  if (exp && exp > now) return Promise.resolve(true);

  return new Promise((resolve) => {
    const opts = {
      hostname: pHost, port: pPort, path: '/api/users/me', method: 'GET',
      headers: { 'X-API-Key': token, 'Accept': 'application/json' },
      rejectUnauthorized: false,
    };
    const transport = pIsHttps ? https : http;
    const ureq = transport.request(opts, ures => {
      ures.resume();
      const ok = ures.statusCode >= 200 && ures.statusCode < 300;
      if (ok) authCache.set(key, now + AUTH_CACHE_TTL_MS);
      resolve(ok);
    });
    ureq.on('error', () => resolve(false));
    ureq.end();
  });
}

async function proxyToAI(req, res, body) {
  if (!AI_PROVIDER) {
    res.writeHead(503, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: { message: 'No AI provider configured on server (set ANTHROPIC_API_KEY or OPENAI_API_KEY)' } }));
    return;
  }
  const token = req.headers['x-api-key'] || '';
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: { message: 'X-API-Key header required' } }));
    return;
  }
  const valid = await validatePortainerToken(token);
  if (!valid) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: { message: 'Invalid or expired Portainer token' } }));
    return;
  }
  if (AI_PROVIDER === 'openai')    return proxyToOpenAI(req, res, body);
  if (AI_PROVIDER === 'anthropic') return proxyToAnthropic(req, res, body);
}

// ── REQUEST HANDLER ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ portainerUrl: PORTAINER_URL, aiAvailable: !!(ANTHROPIC_KEY || OPENAI_KEY), aiProvider: AI_PROVIDER, baseDomain: BASE_DOMAIN }));
    return;
  }

  // Templates endpoint — fetches and caches remote catalogue
  if (pathname === '/templates') {
    handleTemplates(req, res);
    return;
  }

  // Session cache endpoints
  if (pathname === '/cache') {
    handleCache(req, res);
    return;
  }

  // Aggregated environment status — one call per env instead of N calls per deployment
  if (pathname.startsWith('/env-status/')) {
    const envId = pathname.slice('/env-status/'.length).split('/')[0];
    if (!envId) { res.writeHead(400, CORS); res.end(); return; }
    handleEnvStatus(req, res, envId);
    return;
  }

  if (pathname.startsWith('/portainer-api/')) {
    const body = await readBody(req);
    const upstreamPath = '/api/' + pathname.slice('/portainer-api/'.length) + (parsed.search || '');
    proxyToPortainer(req, res, upstreamPath, body);
    return;
  }

  if (pathname === '/ai/triage') {
    const body = await readBody(req);
    proxyToAI(req, res, body);
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'portainer-run.html');
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); res.end('portainer-run.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(htmlPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ── START SERVERS ─────────────────────────────────────────────────────────────
const tlsOptions  = loadTlsOptions();
const httpsServer = https.createServer(tlsOptions, handleRequest);

httpsServer.listen(PORT, () => {
  console.log('\n✅  Portainer Run started');
  console.log(`    UI:        https://localhost${PORT !== 443 ? ':' + PORT : ''}`);
  console.log(`    Portainer: ${PORTAINER_URL}`);
  let aiLine = '✗ not set (set ANTHROPIC_API_KEY or OPENAI_API_KEY)';
  if (AI_PROVIDER === 'anthropic') aiLine = 'anthropic ✓';
  if (AI_PROVIDER === 'openai')    aiLine = `openai ✓ (${OPENAI_MODEL} @ ${OPENAI_BASE_URL})`;
  console.log(`    AI triage: ${aiLine}`);
  console.log(`    TLS:       ${SSL_CERT_PATH ? 'provided certs' : 'self-signed (portainer-run.crt)'}`);
  console.log(`    Cache:     ${CACHE_FILE}`);
  console.log(`    Templates: ${TEMPLATE_URL}`);
  console.log(`    Domain:    ${BASE_DOMAIN || '(not set — NodePort fallback)'}`);

  console.log(`    HTTP ${HTTP_PORT} → redirecting to HTTPS\n`);
});

httpsServer.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n❌  Port ${PORT} already in use\n`);
  else console.error('\n❌ ', e.message, '\n');
  process.exit(1);
});

const httpServer = http.createServer((req, res) => {
  const host   = (req.headers.host || 'localhost').replace(/:\d+$/, '');
  const target = `https://${host}${PORT !== 443 ? ':' + PORT : ''}${req.url}`;
  res.writeHead(301, { Location: target });
  res.end();
});
httpServer.listen(HTTP_PORT);
httpServer.on('error', e => {
  console.warn(`⚠️   HTTP redirect on port ${HTTP_PORT} unavailable: ${e.message}`);
});
