import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import react from 'eslint-plugin-react'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

// The mount path comes from ADDON_BASE_PATH at build time, so a literal
// /addons/<name>/ in client code breaks any build for another path. Build URLs
// from import.meta.env.BASE_URL or router-relative paths.
const MOUNT_PATH_MESSAGE =
  'The mount path comes from ADDON_BASE_PATH: build URLs from import.meta.env.BASE_URL, never /addons/<name>/.'
const MOUNT_PATH = [
  { selector: 'Literal[value=/^\\/addons\\//]', message: MOUNT_PATH_MESSAGE },
  {
    selector: 'TemplateElement[value.raw=/^\\/addons\\//]',
    message: MOUNT_PATH_MESSAGE,
  },
]

// The gateway's CSP is default-src 'self', and airgapped installs can't reach
// the internet, so nothing may load from another origin: scripts, images,
// fonts, frames, fetch and socket targets (portal-template's docs/security.md). Links are
// navigations, not loads, so <a href="https://..."> is fine.
// URL schemes are case-insensitive, so HTTPS:// is as external as https://.
const EXTERNAL_URL = '/^(https?:|wss?:)?\\/\\//i'
const EXTERNAL_LOAD_MESSAGE =
  'The CSP only allows same-origin loads: self-host it, or call it from a server route (portal-template docs/security.md). Links (<a href>) are fine.'
const LOADING_ATTRIBUTE =
  'JSXOpeningElement[name.name=/^(img|script|link|iframe|source|video|audio|embed|object|track)$/] > JSXAttribute[name.name=/^(src|href|srcSet|data|poster)$/]'
// [where the URL sits, what follows the URL node's type], for a string or a
// template literal in that spot.
const LOAD_SITES = [
  // <img src="https://...">, <iframe src={`https://${host}`}>, ...
  [LOADING_ATTRIBUTE, ''],
  [`${LOADING_ATTRIBUTE} > JSXExpressionContainer`, ''],
  // fetch('https://...'), and .get/.post/... on axios or any client.
  ['CallExpression[callee.name="fetch"]', '.arguments:first-child'],
  // window.fetch(...), globalThis.fetch(...), self.fetch(...)
  ['CallExpression[callee.property.name="fetch"]', '.arguments:first-child'],
  [
    'CallExpression[callee.property.name=/^(get|post|put|patch|delete|head|options|request)$/]',
    '.arguments:first-child',
  ],
  // new WebSocket('wss://...'), new EventSource(...), new Worker(...)
  [
    'NewExpression[callee.name=/^(WebSocket|EventSource|Worker|SharedWorker)$/]',
    '.arguments:first-child',
  ],
]
const EXTERNAL_LOADS = LOAD_SITES.flatMap(([site, position]) => [
  {
    selector: `${site} > Literal${position}[value=${EXTERNAL_URL}]`,
    message: EXTERNAL_LOAD_MESSAGE,
  },
  {
    selector: `${site} > TemplateLiteral${position} > TemplateElement:first-child[value.raw=${EXTERNAL_URL}]`,
    message: EXTERNAL_LOAD_MESSAGE,
  },
])

export default tseslint.config(
  { ignores: ['dist', 'design-system'] },
  {
    // Legacy app logic stays JavaScript; new views are TypeScript.
    files: ['**/*.{js,jsx,ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      react,
      sonarjs,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // TypeScript already checks for undefined symbols.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          caughtErrors: 'none',
        },
      ],

      // ── Security gates ────────────────────────────────────────────────────
      // dangerouslySetInnerHTML is an XSS sink. Policy: any use must sanitize
      // via sanitizeHtml() from src/lib/sanitize.ts. ESLint blocks all usage;
      // add an eslint-disable-next-line comment with an explicit justification
      // to opt out for a specific line.
      'react/no-danger': 'error',

      // ── Maintainability ───────────────────────────────────────────────────
      // Cognitive complexity rather than cyclomatic: it counts nesting, not
      // just branches, so a flat switch passes and deeply nested logic
      // doesn't. Split the function; to opt out, add an eslint-disable-next-line
      // comment with the reason, like the security gates above.
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
  {
    // Client-code rules that need no-restricted-syntax. Its options don't
    // merge across config blocks, so they all live in this one. Tests don't
    // ship, and use example URLs and mount paths as fixtures.
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: ['src/**/*.test.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...MOUNT_PATH, ...EXTERNAL_LOADS],
    },
  },
)
