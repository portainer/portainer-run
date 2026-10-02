// ESLint for everything outside client/, which has its own config
// (client/eslint.config.js): the server, the shared runtime catalogue, the
// repo-level tests and scripts/. `pnpm run lint` runs both.
import js from '@eslint/js'
import globals from 'globals'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['client/**', 'data/**'] },
  {
    files: ['server/**/*.js', 'shared/**/*.js', 'test/**/*.js', 'scripts/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      parser: tseslint.parser,
      globals: { ...globals.node },
    },
    plugins: { sonarjs },
    rules: {
      // ── Maintainability ───────────────────────────────────────────────────
      // Cognitive complexity rather than cyclomatic: it counts nesting, not
      // just branches, so a flat switch passes and deeply nested logic
      // doesn't. Split the function; to opt out, add an eslint-disable-next-line
      // comment with the reason.
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
  {
    // The scripts are TypeScript, run directly by Node, and get the same
    // recommended rules as client/. scripts/tsconfig.json supplies their types.
    files: ['scripts/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: 'scripts/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
)
