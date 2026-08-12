import { describe, it, expect, beforeEach } from 'vitest'

import { setLastViewedAddon } from './lastViewedAddon'

const STORAGE_KEY = 'portainer.last_viewed_addon'

function stored(): Record<string, string> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
}

beforeEach(() => {
  localStorage.clear()
})

describe('setLastViewedAddon', () => {
  it('records the add-on against the user', () => {
    setLastViewedAddon('1', 'portainer-run')

    expect(stored()).toEqual({ '1': 'portainer-run' })
  })

  it('keeps other users untouched', () => {
    setLastViewedAddon('1', 'portainer-run')
    setLastViewedAddon('2', 'portal-template')

    expect(stored()).toEqual({
      '1': 'portainer-run',
      '2': 'portal-template',
    })
  })

  it('overwrites the entry for the same user', () => {
    setLastViewedAddon('1', 'portal-template')
    setLastViewedAddon('1', 'portainer-run')

    expect(stored()).toEqual({ '1': 'portainer-run' })
  })

  it('starts over when the stored value is not valid JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not json')

    setLastViewedAddon('1', 'portainer-run')

    expect(stored()).toEqual({ '1': 'portainer-run' })
  })

  it('starts over when the stored value is not an object', () => {
    localStorage.setItem(STORAGE_KEY, '["portal-template"]')

    setLastViewedAddon('1', 'portainer-run')

    expect(stored()).toEqual({ '1': 'portainer-run' })
  })
})
