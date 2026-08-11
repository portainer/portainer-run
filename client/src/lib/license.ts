export interface LicenseInfo {
  valid?: boolean
}

/** Only an explicit `valid: false` gates — an unresolved lookup is unknown, not invalid. */
export function isLicenseInvalid(info: LicenseInfo | undefined): boolean {
  return info?.valid === false
}
