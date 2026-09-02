import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WILDCARD_TLS_SECRET_NAME, wildcardTlsBlock } from './ingress-tls.js'

test('wildcardTlsBlock references the well-known secret for the given host', () => {
  assert.deepEqual(wildcardTlsBlock('hello.run.example.com'), [
    { hosts: ['hello.run.example.com'], secretName: WILDCARD_TLS_SECRET_NAME },
  ])
})

// The name is a manual cross-repo contract with the installer's tls.go — pin
// it explicitly so an accidental rename here doesn't silently break that.
test('the secret name matches the installer-side constant', () => {
  assert.equal(WILDCARD_TLS_SECRET_NAME, 'portainer-run-wildcard-tls')
})
