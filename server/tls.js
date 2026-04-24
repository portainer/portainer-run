import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { CERT_DIR, SSL_CERT_PATH, SSL_KEY_PATH } from './config.js'

function ensureSelfSignedCert(certFile, keyFile) {
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) return
  console.log('🔐  Generating self-signed certificate (3 year validity)...')
  try {
    execSync(
      'openssl req -x509 -newkey rsa:2048 -nodes' +
        ` -keyout "${keyFile}"` +
        ` -out "${certFile}"` +
        ' -days 1095' +
        ' -subj "/CN=portainer-run"' +
        ' -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"',
      { stdio: 'pipe' }
    )
    console.log('✅  Self-signed certificate generated')
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    console.error('❌  Failed to generate self-signed cert:', err.message)
    process.exit(1)
  }
}

/**
 * @returns {import('https').ServerOptions & { key: Buffer; cert: Buffer }}
 */
export function loadTlsOptions() {
  if (SSL_CERT_PATH && SSL_KEY_PATH) {
    if (!fs.existsSync(SSL_CERT_PATH)) {
      console.error(`\n❌  SSL_CERT not found: ${SSL_CERT_PATH}\n`)
      process.exit(1)
    }
    if (!fs.existsSync(SSL_KEY_PATH)) {
      console.error(`\n❌  SSL_KEY not found: ${SSL_KEY_PATH}\n`)
      process.exit(1)
    }
    console.log('🔐  Using provided TLS certificates')
    return {
      cert: fs.readFileSync(SSL_CERT_PATH),
      key: fs.readFileSync(SSL_KEY_PATH),
    }
  }
  const certFile = path.join(CERT_DIR, 'portainer-run.crt')
  const keyFile = path.join(CERT_DIR, 'portainer-run.key')
  ensureSelfSignedCert(certFile, keyFile)
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
}
