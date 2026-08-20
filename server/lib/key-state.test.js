import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyKeyState } from './key-state.js'

const KEY_A = 'fingerprint-of-key-a'
const KEY_B = 'fingerprint-of-key-b'

/** @param {Partial<Parameters<typeof classifyKeyState>[0]>} overrides */
function state(overrides) {
  return classifyKeyState({
    configured: false,
    stored: null,
    current: null,
    encryptedRows: 0,
    gatewayPsk: false,
    decryptsStoredRow: null,
    ...overrides,
  })
}

test('a first run is unconfigured, and records nothing', () => {
  assert.deepEqual(state({}), {
    status: 'unconfigured',
    affectedConnections: 0,
    gatewayPskStale: false,
    rebaseline: false,
  })
})

// R8S-1253
test('a lost key is detected from the rows alone, with no fingerprint', () => {
  assert.deepEqual(state({ encryptedRows: 3 }), {
    status: 'lost',
    affectedConnections: 3,
    gatewayPskStale: false,
    rebaseline: false,
  })
})

test('a lost key is detected from an orphaned gateway PSK', () => {
  assert.deepEqual(state({ gatewayPsk: true }), {
    status: 'lost',
    affectedConnections: 0,
    gatewayPskStale: true,
    rebaseline: false,
  })
})

test('a fingerprint with nothing encrypted behind it is still a first run', () => {
  assert.equal(state({ stored: KEY_A }).status, 'unconfigured')
})

test('first boot on a volume records the key as the baseline', () => {
  assert.deepEqual(state({ configured: true, current: KEY_A }), {
    status: 'ok',
    affectedConnections: 0,
    gatewayPskStale: false,
    rebaseline: true,
  })
})

// R8S-1253
test('a key that cannot open an existing row is a mismatch, not a first boot', () => {
  assert.deepEqual(
    state({
      configured: true,
      current: KEY_A,
      encryptedRows: 2,
      gatewayPsk: true,
      decryptsStoredRow: false,
    }),
    {
      status: 'mismatch',
      affectedConnections: 2,
      gatewayPskStale: true,
      rebaseline: false,
    },
  )
})

test('a key that opens an existing row becomes the baseline', () => {
  assert.deepEqual(
    state({
      configured: true,
      current: KEY_A,
      encryptedRows: 2,
      decryptsStoredRow: true,
    }),
    {
      status: 'ok',
      affectedConnections: 0,
      gatewayPskStale: false,
      rebaseline: true,
    },
  )
})

test('the steady state records nothing', () => {
  assert.deepEqual(state({ configured: true, stored: KEY_A, current: KEY_A }), {
    status: 'ok',
    affectedConnections: 0,
    gatewayPskStale: false,
    rebaseline: false,
  })
})

test('a changed key with nothing behind it is adopted silently', () => {
  assert.deepEqual(state({ configured: true, stored: KEY_A, current: KEY_B }), {
    status: 'ok',
    affectedConnections: 0,
    gatewayPskStale: false,
    rebaseline: true,
  })
})

test('a changed key with data behind it is a mismatch, and is not adopted', () => {
  assert.deepEqual(
    state({
      configured: true,
      stored: KEY_A,
      current: KEY_B,
      encryptedRows: 2,
      gatewayPsk: true,
    }),
    {
      status: 'mismatch',
      affectedConnections: 2,
      gatewayPskStale: true,
      rebaseline: false,
    },
  )
})

test('a changed key is a mismatch on a stale PSK alone', () => {
  assert.equal(
    state({ configured: true, stored: KEY_A, current: KEY_B, gatewayPsk: true })
      .status,
    'mismatch',
  )
})
