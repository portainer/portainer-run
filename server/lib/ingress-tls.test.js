import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wildcardTlsBlock } from './ingress-tls.js'

test('wildcardTlsBlock references the well-known secret for the given host', () => {
  assert.deepEqual(wildcardTlsBlock('hello.run.example.com'), [
    {
      hosts: ['hello.run.example.com'],
      secretName: 'portainer-run-wildcard-tls',
    },
  ])
})
