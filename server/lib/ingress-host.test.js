import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findHostConflict, hostConflictMessage } from './ingress-host.js'

/**
 * A Portainer K8sIngressInfo struct — capitalised fields, with `Hosts` already
 * flattened and deduped from every spec.rules[].host by the Portainer API.
 *
 * @param {string} name @param {string} ns @param {string[]} hosts
 */
function ingress(name, ns, hosts) {
  return { Name: name, Namespace: ns, Hosts: hosts }
}

const SELF = { ns: 'cert-manager', appName: 'hello' }

test('a free hostname has no conflict', () => {
  const existing = [ingress('other', 'app', ['other.run.example.com'])]

  assert.equal(findHostConflict(existing, 'hello.run.example.com', SELF), null)
})

// DEV-151: same app name in a second namespace claimed a hostname the first already had
test('a hostname taken in another namespace is a conflict', () => {
  const existing = [ingress('hello', 'app', ['hello.run.example.com'])]

  assert.deepEqual(findHostConflict(existing, 'hello.run.example.com', SELF), {
    name: 'hello',
    namespace: 'app',
  })
})

test("the app's own ingress is not a conflict, so a redeploy is allowed", () => {
  const existing = [ingress('hello', 'cert-manager', ['hello.run.example.com'])]

  assert.equal(findHostConflict(existing, 'hello.run.example.com', SELF), null)
})

test('a same-named ingress in another namespace is still a conflict', () => {
  const existing = [
    ingress('hello', 'cert-manager', ['hello.run.example.com']),
    ingress('hello', 'app', ['hello.run.example.com']),
  ]

  assert.deepEqual(findHostConflict(existing, 'hello.run.example.com', SELF), {
    name: 'hello',
    namespace: 'app',
  })
})

test('host matching ignores case and a trailing dot', () => {
  const existing = [ingress('hello', 'app', ['Hello.Run.Example.Com.'])]

  assert.deepEqual(findHostConflict(existing, 'hello.run.example.com', SELF), {
    name: 'hello',
    namespace: 'app',
  })
})

test('every host on an ingress is checked, not just the first', () => {
  const existing = [
    ingress('multi', 'app', ['first.run.example.com', 'hello.run.example.com']),
  ]

  assert.deepEqual(findHostConflict(existing, 'hello.run.example.com', SELF), {
    name: 'multi',
    namespace: 'app',
  })
})

test('an admin-created ingress conflicts just like a managed one', () => {
  const existing = [
    ingress('legacy-site', 'default', ['hello.run.example.com']),
  ]

  assert.deepEqual(findHostConflict(existing, 'hello.run.example.com', SELF), {
    name: 'legacy-site',
    namespace: 'default',
  })
})

test('a blank host cannot conflict', () => {
  const existing = [ingress('hello', 'app', ['hello.run.example.com'])]

  assert.equal(findHostConflict(existing, '', SELF), null)
  assert.equal(findHostConflict(existing, '   ', SELF), null)
})

test('missing or malformed ingress data is tolerated', () => {
  assert.equal(findHostConflict(null, 'hello.run.example.com', SELF), null)
  assert.equal(findHostConflict([{}], 'hello.run.example.com', SELF), null)
  assert.equal(
    findHostConflict(
      [{ Name: 'x', Namespace: 'y' }],
      'hello.run.example.com',
      SELF,
    ),
    null,
  )
})

// Portainer emits a "" host for a catch-all rule with no host set; it must not
// swallow every lookup as a match.
test('a catch-all ingress with a blank host never matches', () => {
  const existing = [ingress('catch-all', 'app', [''])]

  assert.equal(findHostConflict(existing, 'hello.run.example.com', SELF), null)
})

test('the conflict message names the owning app and project space', () => {
  const message = hostConflictMessage('hello.run.example.com', {
    name: 'hello',
    namespace: 'app',
  })

  assert.match(message, /hello\.run\.example\.com/)
  assert.match(message, /"hello"/)
  assert.match(message, /"app"/)
})
