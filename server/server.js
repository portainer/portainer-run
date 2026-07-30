import http from 'node:http'
import {
  AI_PROVIDER,
  CACHE_FILE,
  PORT,
  PORTAINER_URL,
  BASE_DOMAIN,
} from './config.js'
import { handleRequest } from './handler.js'

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

httpServer.listen(PORT, () => {
  console.log('\n✅  Portainer-Run started')
  console.log(`    UI:        http://localhost:${PORT}`)
  console.log(`    Portainer: ${PORTAINER_URL}`)
  console.log(
    `    AI triage: ${AI_PROVIDER ? AI_PROVIDER + ' ✓' : '✗ not set (set ANTHROPIC_API_KEY or OPENAI_API_KEY)'}`,
  )
  console.log(`    Cache:     ${CACHE_FILE}`)
  console.log(
    `    Domain:    ${BASE_DOMAIN || '(not set — NodePort fallback)'}\n`,
  )
})

httpServer.on('error', onError)
