import { describe, it, expect, beforeEach } from 'vitest'

import { storeReturnUrl } from './returnUrl'

const STORAGE_KEY = 'portainer.RETURN_URL'

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/addons/portainer-run/applications')
})

describe('storeReturnUrl', () => {
  // Portainer reads this key with JSON.parse and silently falls back on a parse
  // error, so a raw string here would lose the returnUrl with no visible failure.
  it('stores the location JSON-encoded, as Portainer reads it back', () => {
    storeReturnUrl()

    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify('/addons/portainer-run/applications'),
    )
  })

  it('records the deep page, with its query and fragment', () => {
    window.history.replaceState(
      {},
      '',
      '/addons/portainer-run/applications/1/ns/app?tab=logs#tail',
    )

    storeReturnUrl()

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toBe(
      '/addons/portainer-run/applications/1/ns/app?tab=logs#tail',
    )
  })
})
