import http from 'node:http'
import { CACHE_FILE, PORT, PORTAINER_URL } from './config.js'
import {
  adoptEnvKey,
  aiProvider,
  baseDomain,
  credentialHealth,
  ensureHydrated,
  isConfigured,
} from './settings.js'
import { handleRequest } from './handler.js'
import { reportKeyContinuity } from './lib/key-continuity.js'
import { warnUnverified } from './lib/portainer-tls.js'
import { resolvePortainerTarget } from './resolve-portainer.js'

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

const ADOPT_RETRY_INTERVAL = 15_000

/**
 * Keep offering the key to Portainer until its home is decided.
 *
 * The credential is mounted optional and Portainer may still be starting, so a
 * first attempt can fail with nothing wrong.
 */
async function adoptWhenPossible() {
  if ((await adoptEnvKey().catch(() => 'retry')) !== 'retry') return
  setTimeout(adoptWhenPossible, ADOPT_RETRY_INTERVAL).unref()
}

// TLS terminates at the proxy in front of us (the Portainer addon gateway in
// production), which forwards plain HTTP, so this server never speaks HTTPS.
const httpServer = http.createServer(handleRequest)

warnUnverified(resolvePortainerTarget()?.isHttps)

httpServer.listen(PORT, async () => {
  // With a credential mounted this comes up configured, no user behind it.
  // Listening first keeps the probes served while Portainer is being reached.
  await ensureHydrated()

  // Not awaited: nothing below reads the result, and it can retry for minutes.
  void adoptWhenPossible()

  // Only meaningful once the key is in hand: judged before the fetch, an
  // instance that keeps its key in Portainer reports every restart as a
  // dropped one.
  const continuity = reportKeyContinuity()

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
