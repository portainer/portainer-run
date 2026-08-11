import { describe, it, expect } from 'vitest'
import { isLicenseInvalid } from './license'

describe('isLicenseInvalid', () => {
  it('gates when Portainer reports no valid license', () => {
    expect(isLicenseInvalid({ valid: false })).toBe(true)
  })

  it('lets a valid license through', () => {
    expect(isLicenseInvalid({ valid: true })).toBe(false)
  })

  it('does not gate an unresolved lookup, so a hiccup cannot lock out a licensed instance', () => {
    expect(isLicenseInvalid(undefined)).toBe(false)
  })

  it('does not gate a 200 missing the field — Portainer always sends it, so this is a malformed body', () => {
    expect(isLicenseInvalid({})).toBe(false)
  })
})
