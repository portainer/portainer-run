import Markdown from 'markdown-to-jsx'

// Single renderer for untrusted AI output. disableParsingRawHTML makes any
// embedded HTML render as literal text, so prompt-injected markup can never
// become live elements.
const OPTIONS = {
  disableParsingRawHTML: true,
  forceBlock: true,
}

/**
 * @param {object} props
 * @param {string} props.children markdown text
 */
export function AssistantMarkdown({ children }) {
  return <Markdown options={OPTIONS}>{children}</Markdown>
}
