/**
 * Portainer Run — CORS proxy + Anthropic relay server
 *
 * Responsibilities:
 *  1. Serve HTTPS (443 by default) with self-signed or real certs
 *  2. Redirect HTTP (80) → HTTPS
 *  3. Proxy /portainer-api/* → Portainer (CORS bypass, user token passed through)
 *  4. Proxy /ai/triage → Anthropic API (key stored server-side, never in browser)
 *
 * .env config:
 *   PORTAINER_URL=https://portainer.example.com:9443   (required)
 *   ANTHROPIC_API_KEY=sk-ant-...                        (optional, enables AI triage)
 *   PORT=443                                            (optional, default 443)
 *   HTTP_PORT=80                                        (optional, default 80, redirects to HTTPS)
 *   SSL_CERT=/path/to/fullchain.pem                     (optional, uses self-signed if not set)
 *   SSL_KEY=/path/to/privkey.pem                        (optional, uses self-signed if not set)
 *   SSL_CERT_DIR=/certs                                 (optional, dir for self-signed cert storage)
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const cp    = require('child_process');

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
const PORT          = parseInt(process.env.PORT      || '443');
const HTTP_PORT     = parseInt(process.env.HTTP_PORT || '80');
const SSL_CERT_PATH = process.env.SSL_CERT || '';
const SSL_KEY_PATH  = process.env.SSL_KEY  || '';
const CERT_DIR      = process.env.SSL_CERT_DIR || __dirname;

if (!PORTAINER_URL) {
  console.error('\n❌  PORTAINER_URL must be set\n');
  process.exit(1);
}
if (!ANTHROPIC_KEY) {
  console.warn('\n⚠️   ANTHROPIC_API_KEY not set — AI triage will be unavailable\n');
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
    console.error('    Install openssl or provide SSL_CERT and SSL_KEY paths');
    process.exit(1);
  }
}

function loadTlsOptions() {
  if (SSL_CERT_PATH && SSL_KEY_PATH) {
    if (!fs.existsSync(SSL_CERT_PATH)) {
      console.error(`\n❌  SSL_CERT file not found: ${SSL_CERT_PATH}\n`);
      process.exit(1);
    }
    if (!fs.existsSync(SSL_KEY_PATH)) {
      console.error(`\n❌  SSL_KEY file not found: ${SSL_KEY_PATH}\n`);
      process.exit(1);
    }
    console.log('🔐  Using provided TLS certificates');
    return {
      cert: fs.readFileSync(SSL_CERT_PATH),
      key:  fs.readFileSync(SSL_KEY_PATH),
    };
  }

  const certFile = path.join(CERT_DIR, 'portainer-run.crt');
  const keyFile  = path.join(CERT_DIR, 'portainer-run.key');
  ensureSelfSignedCert(certFile, keyFile);
  return {
    cert: fs.readFileSync(certFile),
    key:  fs.readFileSync(keyFile),
  };
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
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };
  if (userToken) headers['X-API-Key'] = userToken;
  if (body && body.length) headers['Content-Length'] = body.length;

  const opts = {
    hostname: pHost, port: pPort,
    path: upstreamPath, method: req.method,
    headers, rejectUnauthorized: false,
  };

  const transport = pIsHttps ? https : http;
  const upstream  = transport.request(opts, upRes => {
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
    'Content-Type':      'application/json',
    'x-api-key':         ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
    'Content-Length':    outBody.length,
  };

  const upstream = https.request(
    { hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST', headers },
    upRes => {
      const resHeaders = {
        ...CORS,
        'Content-Type':  upRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-cache',
      };
      res.writeHead(upRes.statusCode, resHeaders);
      upRes.pipe(res);
    }
  );
  upstream.on('error', e => {
    console.error('[anthropic proxy error]', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Anthropic proxy error', message: e.message }));
    }
  });
  upstream.write(outBody);
  upstream.end();
}

// ── REQUEST HANDLER ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ portainerUrl: PORTAINER_URL, aiAvailable: !!ANTHROPIC_KEY }));
    return;
  }

  if (pathname.startsWith('/portainer-api/')) {
    const body         = await readBody(req);
    const upstreamPath = '/api/' + pathname.slice('/portainer-api/'.length) + (parsed.search || '');
    proxyToPortainer(req, res, upstreamPath, body);
    return;
  }

  if (pathname === '/ai/triage') {
    const body = await readBody(req);
    proxyToAnthropic(req, res, body);
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'portainer-run.html');
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('portainer-run.html not found');
      return;
    }
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
  console.log(`    UI:        https://localhost:${PORT === 443 ? '' : ':' + PORT}`);
  console.log(`    Portainer: ${PORTAINER_URL}`);
  console.log(`    AI triage: ${ANTHROPIC_KEY ? '✓ configured' : '✗ not set'}`);
  console.log(`    TLS:       ${SSL_CERT_PATH ? 'provided certs' : 'self-signed (portainer-run.crt)'}`);
  console.log(`    HTTP ${HTTP_PORT} → redirecting to HTTPS\n`);
});

httpsServer.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} already in use. Set PORT=<other> in .env\n`);
  } else {
    console.error('\n❌ ', e.message, '\n');
  }
  process.exit(1);
});

// HTTP → HTTPS redirect (best-effort, non-fatal if port unavailable)
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
