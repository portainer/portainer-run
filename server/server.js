import http from 'node:http'
import { CACHE_FILE, PORT, PORTAINER_URL } from './config.js'
import {
  aiProvider,
  baseDomain,
  credentialHealth,
  ensureHydrated,
  isConfigured,
} from './settings.js'
import { hasMachineCredential } from './machine-credential.js'
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

httpServer.listen(PORT, async () => {
  // Comes up configured with no user behind it. Listening first keeps the
  // probes served while Portainer is being reached.
  if (hasMachineCredential()) await ensureHydrated()

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
    // An add-on that read Portainer and found nothing stored is new.
    `    Config:    ${
      credentialHealth() !== 'ok'
        ? 'could not be read from Portainer ⚠️'
        : !isConfigured()
          ? 'awaiting an admin to run setup'
          : continuity.status === 'mismatch'
            ? 'encryption key changed ⚠️'
            : 'ready ✓'
    }\n`,
  )
})

httpServer.on('error', onError)
