#!/usr/bin/env node
/**
 * Checks the repo-wide rules in AGENTS.md that ESLint can't see: which files exist, and what
 * stylesheets say, since ESLint only parses TypeScript. `pnpm run lint:repo` runs it, and so does
 * `lint:deep`.
 *
 * Looks at tracked files plus untracked ones that aren't ignored, so a new file fails before it's
 * committed. design-system/ is a submodule, so its files never appear.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')

type Rule = (files: string[]) => string[]

// Agent instructions live in AGENTS.md files, at the root or in a subfolder (see AGENTS.md).
const noClaudeMd: Rule = (files) =>
  files
    .filter((file) => basename(file).toLowerCase() === 'claude.md')
    .map(
      (file) =>
        `${file}: this repo uses AGENTS.md, not CLAUDE.md. Move it to AGENTS.md.`,
    )

// The mount path isn't hardcoded (AGENTS.md). ESLint rejects an /addons/ literal in client/src/'s
// TypeScript; this does the same for its stylesheets, where url('/addons/...') would break an
// install mounted anywhere else. A relative url() or an imported asset follows the base path.
const STYLESHEET = /^client\/src\/.*\.(css|scss|sass|less)$/
const MOUNT_PATH = /\/addons\//
const noMountPathInStyles: Rule = (files) =>
  files
    .filter(
      (file) => STYLESHEET.test(file) && existsSync(join(REPO_ROOT, file)),
    )
    .flatMap((file) =>
      readFileSync(join(REPO_ROOT, file), 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          MOUNT_PATH.test(line)
            ? [
                `${file}:${i + 1}: hardcodes the /addons/ mount path. Use a relative url() or ` +
                  `import the asset, so it follows the base path.`,
              ]
            : [],
        ),
    )

const RULES: Rule[] = [noClaudeMd, noMountPathInStyles]

function repoFiles(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  )
  return output.split('\n').filter(Boolean)
}

function main(): void {
  const files = repoFiles()
  const errors = RULES.flatMap((rule) => rule(files))
  for (const error of errors) console.error(`error: ${error}`)
  if (errors.length > 0) process.exit(1)
  console.log(`Repo rules: ${files.length} files checked`)
}

main()
