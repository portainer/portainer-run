import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findStackNameConflict,
  stackNameConflictMessage,
} from './stack-name.js'

/** A stack as GET /api/stacks reports it. Type 3 is a Kubernetes stack. */
function stack(name, ns, envId, type = 3) {
  return { Name: name, Namespace: ns, EndpointId: envId, Type: type }
}

const SELF = { envId: '2', ns: 'app', name: 'hello' }

test('a free name has no conflict', () => {
  assert.equal(findStackNameConflict([stack('other', 'app', 2)], SELF), null)
})

test('the same name in the same namespace is a conflict', () => {
  assert.deepEqual(findStackNameConflict([stack('hello', 'app', 2)], SELF), {
    name: 'hello',
  })
})

// Portainer scopes uniqueness per namespace, so this must NOT be reported.
test('the same name in another namespace is allowed', () => {
  assert.equal(findStackNameConflict([stack('hello', 'other', 2)], SELF), null)
})

test('the same name in another environment is allowed', () => {
  assert.equal(findStackNameConflict([stack('hello', 'app', 99)], SELF), null)
})

// Portainer compares with EqualFold, so a differently-cased stack still blocks us.
test('name matching is case-insensitive', () => {
  assert.deepEqual(findStackNameConflict([stack('HeLLo', 'app', 2)], SELF), {
    name: 'HeLLo',
  })
})

test('the reported name preserves the existing stack’s own casing', () => {
  const conflict = findStackNameConflict([stack('MyApp', 'app', 2)], {
    ...SELF,
    name: 'myapp',
  })

  assert.equal(conflict.name, 'MyApp')
})

test('non-Kubernetes stacks are ignored', () => {
  const swarm = stack('hello', 'app', 2, 1)
  const compose = stack('hello', 'app', 2, 2)

  assert.equal(findStackNameConflict([swarm, compose], SELF), null)
})

// envId arrives from the query string as a string, Portainer reports a number.
test('a numeric and a string environment id compare equal', () => {
  assert.deepEqual(findStackNameConflict([stack('hello', 'app', 2)], SELF), {
    name: 'hello',
  })
  assert.deepEqual(
    findStackNameConflict([stack('hello', 'app', '2')], { ...SELF, envId: 2 }),
    { name: 'hello' },
  )
})

test('a blank name cannot conflict', () => {
  assert.equal(
    findStackNameConflict([stack('hello', 'app', 2)], { ...SELF, name: '' }),
    null,
  )
})

test('missing or malformed stack data is tolerated', () => {
  assert.equal(findStackNameConflict(null, SELF), null)
  assert.equal(findStackNameConflict([{}], SELF), null)
  assert.equal(findStackNameConflict([{ Type: 3 }], SELF), null)
})

test('the conflict message names the app and the project space', () => {
  const message = stackNameConflictMessage({ name: 'hello' }, 'app')

  assert.match(message, /"hello"/)
  assert.match(message, /"app"/)
})
