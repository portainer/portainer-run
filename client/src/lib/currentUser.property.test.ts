import { afterEach, describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  CURRENT_USER_STORAGE_KEY,
  getCurrentUser,
  writeCurrentUser,
} from './currentUser.js'

afterEach(() => {
  localStorage.clear()
})

// The record is shared with Portainer and any same-origin code, so it can hold anything: valid
// JSON of any shape, a record whose fields have the wrong types, or text that isn't JSON at all.
const storedRecord = fc.oneof(
  fc.json(),
  fc.string(),
  fc
    .record(
      {
        state: fc.oneof(
          fc.anything(),
          fc.record({ user: fc.anything() }, { requiredKeys: [] }),
        ),
      },
      { requiredKeys: [] },
    )
    .map((record) => JSON.stringify(record) ?? ''),
)

describe('current user record properties', () => {
  it('reads any stored value without throwing', () => {
    fc.assert(
      fc.property(storedRecord, (raw) => {
        localStorage.setItem(CURRENT_USER_STORAGE_KEY, raw)
        expect(() => getCurrentUser()).not.toThrow()
      }),
    )
  })

  it('writes the patch over any stored value without throwing', () => {
    fc.assert(
      fc.property(storedRecord, fc.integer(), (raw, id) => {
        localStorage.setItem(CURRENT_USER_STORAGE_KEY, raw)

        expect(writeCurrentUser({ Id: id }).state?.user?.Id).toBe(id)
        expect(getCurrentUser()?.Id).toBe(id)
      }),
    )
  })
})
