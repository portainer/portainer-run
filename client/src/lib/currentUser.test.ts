import { afterEach, describe, it, expect } from 'vitest'
import {
  CURRENT_USER_STORAGE_KEY,
  getCurrentUser,
  writeCurrentUser,
} from './currentUser.js'

afterEach(() => {
  localStorage.clear()
})

describe('a stored record that is valid JSON but not an object', () => {
  it.each(['null', '5', '"text"', '[]', 'true'])(
    '%s reads as no user, and is replaced on write',
    (raw) => {
      localStorage.setItem(CURRENT_USER_STORAGE_KEY, raw)

      expect(getCurrentUser()).toBeUndefined()
      expect(writeCurrentUser({ Id: 3 })).toEqual({
        state: { user: { Id: 3 } },
      })
    },
  )
})
