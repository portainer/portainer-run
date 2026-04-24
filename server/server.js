import http from 'node:http'
import https from 'node:https'
import {
  ANTHROPIC_KEY,
  AI_PROVIDER,
  CACHE_FILE,
  HTTP_PORT,
  OPENAI_KEY,
  PORT,
  PORTAINER_URL,
  SSL_CERT_PATH,
  TEMPLATE_URL,
  BASE_DOMAIN,
} from './config.js'
import { handleRequest } from './handler.js'
import { loadTlsOptions } from './tls.js'

const tlsOptions = loadTlsOptions()
const httpsServer = https.createServer(tlsOptions, handleRequest)

httpsServer.listen(PORT, () => {
  console.log('\n✅  Portainer Run started')
  console.log(
    `    UI:        https://localhost${PORT !== 443 ? ':' + PORT : ''}`
  )
  console.log(`    Portainer: ${PORTAINER_URL}`)
  console.log(
    `    AI triage: ${AI_PROVIDER ? AI_PROVIDER + ' ✓' : '✗ not set (set ANTHROPIC_API_KEY or OPENAI_API_KEY)'}`
  )
  console.log(
    `    TLS:       ${SSL_CERT_PATH ? 'provided certs' : 'self-signed (portainer-run.crt)'}`
  )
  console.log(`    Cache:     ${CACHE_FILE}`)
  console.log(`    Templates: ${TEMPLATE_URL}`)
  console.log(
    `    Domain:    ${BASE_DOMAIN || '(not set — NodePort fallback)'}`
  )
  if (HTTP_PORT > 0) {
    console.log(`    HTTP ${HTTP_PORT} → redirecting to HTTPS\n`)
  } else {
    console.log('    HTTP redirect: disabled (HTTP_PORT=0)\n')
  }
})

httpsServer.on('error', (e) => {
  const err = e
  if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} already in use\n`)
  } else {
    console.error('\n❌ ', (err && err instanceof Error && err.message) || err, '\n')
  }
  process.exit(1)
})

if (HTTP_PORT > 0) {
  const httpServer = http.createServer((req, res) => {
    const host = (req.headers.host || 'localhost').replace(/:\d+$/, '')
    const target = `https://${host}${PORT !== 443 ? ':' + PORT : ''}${req.url || '/'}`
    res.writeHead(301, { Location: target })
    res.end()
  })
  httpServer.listen(HTTP_PORT, () => {})
  httpServer.on('error', (e) => {
    console.warn(`⚠️   HTTP redirect on port ${HTTP_PORT} unavailable: ${e.message}`)
  })
}
