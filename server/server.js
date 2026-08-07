import http from 'node:http'
import { CACHE_FILE, PORT, PORTAINER_URL } from './config.js'
import { aiProvider, baseDomain, isConfigured } from './settings.js'
import { handleRequest } from './handler.js'
import { reportKeyContinuity } from './lib/key-continuity.js'

function onError(e) {
  const err = e
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    err.code === 'EADDRINUSE'
  ) {
    console.error(`\n❌  Port ${PORT} already in use\n`)
  } else {
    console.error(
      '\n❌ ',
      (err && err instanceof Error && err.message) || err,
      '\n',
    )
  }
  process.exit(1)
}

// TLS terminates at the proxy in front of us (the Portainer addon gateway in
// production), which forwards plain HTTP, so this server never speaks HTTPS.
const httpServer = http.createServer(handleRequest)

// Warn on a changed key before listen, so it heads the pod log.
const continuity = reportKeyContinuity()

httpServer.listen(PORT, () => {
  console.log(
    isConfigured()
      ? '\n✅  Portainer-Run started'
      : '\n⏳  Portainer-Run started — awaiting setup',
  )
  console.log(`    UI:        http://localhost:${PORT}`)
  console.log(`    Portainer: ${PORTAINER_URL}`)
  console.log(
    `    AI triage: ${aiProvider() ? aiProvider() + ' ✓' : '✗ not configured'}`,
  )
  console.log(`    Cache:     ${CACHE_FILE}`)
  console.log(
    `    Domain:    ${baseDomain() || '(not set — NodePort fallback)'}`,
  )
  console.log(
    `    Config:    ${
      !isConfigured()
        ? 'awaiting an admin to run setup (fetched from Portainer on demand)'
        : continuity.status === 'mismatch'
          ? 'encryption key changed ⚠️'
          : 'ready ✓'
    }\n`,
  )
})

httpServer.on('error', onError)
