import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { sanitizeHtml } from './sanitize'

// The allowlist in sanitize.ts, restated: the test is the spec for what may reach the DOM.
const ALLOWED_TAG = /^<\/?(p|br|strong|em|code|pre|ul|ol|li|h3)\s*\/?>$/

// Untrusted HTML built from the pieces XSS payloads are made of, mixed with arbitrary text, so
// fast-check explores broken nesting, unclosed tags and stray quotes as well as clean markup.
const fragment = fc.oneof(
  fc.constantFrom(
    '<script>',
    '</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">',
    '</a>',
    '<p>',
    '</p>',
    '<strong onclick="steal()">',
    '</strong>',
    '<svg onload=alert(1)>',
    '<iframe src="https://evil.example">',
    '<style>body{}</style>',
    '<!--',
    '-->',
    '<h3 style="x">',
    '<br/>',
    '"',
    "'",
    '<',
    '>',
    '&',
    'javascript:',
  ),
  fc.string(),
)
const untrustedHtml = fc
  .array(fragment, { maxLength: 20 })
  .map((parts) => parts.join(''))

describe('sanitizeHtml properties', () => {
  it('only ever emits allowlisted tags, with no attributes', () => {
    fc.assert(
      fc.property(untrustedHtml, (dirty) => {
        const tags = sanitizeHtml(dirty).match(/<[^>]*>/g) ?? []
        expect(tags.filter((tag) => !ALLOWED_TAG.test(tag))).toEqual([])
      }),
    )
  })
  // Not idempotent, and that's fine: sanitizing twice can re-nest invalid
  // markup (<h3><h3></h3></h3> comes back as <h3></h3><h3></h3>, as a browser
  // would parse it). The property above already covers sanitized output, since
  // that's just more input.
})
