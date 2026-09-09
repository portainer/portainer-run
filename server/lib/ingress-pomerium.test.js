import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pomeriumAnnotations } from './ingress-pomerium.js'

test('pomeriumAnnotations adds the allow-any-authenticated-user annotation for the pomerium ingress class', () => {
  assert.deepEqual(pomeriumAnnotations('pomerium'), {
    'ingress.pomerium.io/allow_any_authenticated_user': 'true',
  })
})

test('pomeriumAnnotations is empty for every other ingress class', () => {
  assert.deepEqual(pomeriumAnnotations('traefik'), {})
  assert.deepEqual(pomeriumAnnotations('nginx'), {})
})

test('pomeriumAnnotations is empty when no ingress class is given', () => {
  assert.deepEqual(pomeriumAnnotations(undefined), {})
  assert.deepEqual(pomeriumAnnotations(''), {})
})
