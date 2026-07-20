/**
 * A Portainer environment (endpoint) as surfaced by the app store. Only the
 * fields the UI reads are modelled; the store itself is still JavaScript.
 */
export interface Environment {
  Id: string | number
  Name: string
}
