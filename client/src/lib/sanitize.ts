import sanitize from 'sanitize-html'

// Permitted tags for AI/markdown-derived HTML. Matches the pattern used in
// portainer-suite (MotdPanel, TemplateNote, Tooltip) but with a tighter
// allowlist suited to addon content — no inline styles or attributes.
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'h3',
]

/**
 * Sanitize untrusted HTML at the render sink.
 *
 * Treat AI model output as untrusted input: prompt injection can craft HTML
 * that becomes an XSS payload when rendered. Always pass AI output through
 * this function before using dangerouslySetInnerHTML.
 *
 * Usage (mirrors portainer-suite convention):
 *   // eslint-disable-next-line react/no-danger -- output sanitized via sanitizeHtml
 *   <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(aiOutput) }} />
 */
export function sanitizeHtml(dirty: string): string {
  return sanitize(dirty, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {},
  })
}
