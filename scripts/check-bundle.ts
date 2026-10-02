#!/usr/bin/env node
/**
 * Checks the built SPA for loads from another origin: the gateway's CSP is default-src 'self', and
 * airgapped installs can't reach the internet. `pnpm run build` runs it after vite build.
 *
 * Covers what the build declares: src/href on loading elements in the HTML, and url() / @import in
 * the CSS, including what dependencies add. ESLint covers literal URLs in our own code; a URL built
 * at runtime still needs review (portal-template's docs/security.md).
 *
 *   node scripts/check-bundle.ts [dist-dir]       # default client/dist
 */
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// An absolute or protocol-relative URL: https://host, //host, wss://host.
const EXTERNAL = String.raw`(?:(?:https?|wss?):)?//[^"'\s>)]+`

// A tag that loads what its attributes point at, and those attributes. Each tag is scanned for
// all of them, so a later attribute isn't hidden behind an earlier one.
const LOADING_TAG =
  /<(?:script|link|img|iframe|source|video|audio|embed|object|track)\b[^>]*>/gi
const LOADING_ATTRIBUTE =
  /\s(src|href|srcset|data|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const EXTERNAL_START = new RegExp(String.raw`^${EXTERNAL}`, 'i')

const CSS_PATTERNS = [
  new RegExp(String.raw`url\(\s*["']?(${EXTERNAL})`, 'gi'),
  // @import "https://..."; the url() form is caught above.
  new RegExp(String.raw`@import\s+["'](${EXTERNAL})`, 'gi'),
]

// The URLs an attribute loads: a srcset is a comma-separated list of "url descriptor"
// candidates, and any of them can be external.
function attributeUrls(name: string, value: string): string[] {
  if (name.toLowerCase() !== 'srcset') return [value.trim()]
  return value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0])
}

function htmlLoads(text: string): string[] {
  return [...text.matchAll(LOADING_TAG)].flatMap(([tag]) =>
    [...tag.matchAll(LOADING_ATTRIBUTE)]
      .flatMap(([, name, ...values]) =>
        attributeUrls(name, values.find((v) => v !== undefined) ?? ''),
      )
      .filter((url) => EXTERNAL_START.test(url)),
  )
}

function cssLoads(text: string): string[] {
  return CSS_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[1]),
  )
}

const SCANNERS: Record<string, (text: string) => string[]> = {
  '.html': htmlLoads,
  '.css': cssLoads,
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function externalLoads(file: string): string[] {
  const scan = SCANNERS[extname(file)]
  return scan ? scan(readFileSync(file, 'utf8')) : []
}

function main(): void {
  const label = process.argv[2] ?? 'client/dist'
  const dist = resolve(REPO_ROOT, label)
  const files = filesUnder(dist)
  const errors = files.flatMap((file) =>
    externalLoads(file).map(
      (url) =>
        `${join(label, relative(dist, file))} loads ${url}. The CSP only allows same-origin loads: ` +
        `self-host it (portal-template's docs/security.md).`,
    ),
  )
  for (const error of errors) console.error(`error: ${error}`)
  if (errors.length > 0) process.exit(1)
  console.log(`Bundle: no external loads in ${files.length} built files`)
}

main()
