#!/usr/bin/env node
/**
 * Checks the repo-wide rules in AGENTS.md that ESLint can't see, because they're about which files
 * exist rather than what the code says. `pnpm run lint:repo` runs it, and so does `lint:deep`.
 *
 * Looks at tracked files plus untracked ones that aren't ignored, so a new file fails before it's
 * committed. design-system/ is a submodule, so its files never appear.
 */
import { execFileSync } from 'node:child_process'
import { basename, resolve } from 'node:path'

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

const RULES: Rule[] = [noClaudeMd]

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
