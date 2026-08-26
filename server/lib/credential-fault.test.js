import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOutcome } from './credential-fault.js'

/** @param {Partial<Parameters<typeof classifyOutcome>[0]>} outcome */
function verdict(outcome) {
  return classifyOutcome(outcome)
}

test('an untrusted certificate is a fault whoever called', () => {
  assert.deepEqual(verdict({ certificateTrusted: false }), {
    record: 'certificate',
  })
})

test('a verified handshake clears a certificate fault on any call', () => {
  assert.deepEqual(verdict({ certificateTrusted: true }), {
    clear: 'certificate',
  })
})

test("the add-on's own credential being refused is a fault", () => {
  assert.deepEqual(verdict({ usedMachineCredential: true, status: 401 }), {
    record: 'rejected',
  })
})

test('the add-on being denied a route is not a credential fault', () => {
  assert.equal(verdict({ usedMachineCredential: true, status: 403 }), null)
})

test("a caller's own token being refused says nothing", () => {
  assert.equal(verdict({ usedMachineCredential: false, status: 401 }), null)
})

test('an unreachable Portainer says nothing', () => {
  assert.equal(verdict({ usedMachineCredential: true, status: null }), null)
})

test('a server error says nothing, so it cannot clear a rejection', () => {
  assert.equal(verdict({ usedMachineCredential: true, status: 500 }), null)
  assert.equal(verdict({ usedMachineCredential: true, status: 404 }), null)
})

test('a call that worked on the machine credential clears everything', () => {
  assert.deepEqual(verdict({ usedMachineCredential: true, status: 200 }), {
    clear: 'all',
  })
})

test('a call that worked on a borrowed admin token leaves a rejection standing', () => {
  assert.deepEqual(verdict({ usedMachineCredential: false, status: 200 }), {
    clear: 'certificate',
  })
})
