#!/usr/bin/env node
/**
 * Checks that every relative link in the repo's Markdown resolves: the file or folder exists and,
 * for a #fragment into a Markdown file, the heading does too. `pnpm run lint:repo` runs it, and so
 * does `lint:deep`.
 *
 * External links (https:, mailto: ...) aren't checked: many point at private repos or Notion,
 * which need a login, so a check without one would fail on links that work.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// [text](target "title") and ![alt](target), reference definitions ([label]: target, but not
// [^footnote]: text), and reference usages: [text][label], and [label][] for a label of its text.
const INLINE_LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g
const REFERENCE_DEFINITION =
  /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*<?(\S+?)>?(?:[ \t].*)?$/gm
const REFERENCE_USAGE = /\[([^\]]*)\]\[([^\]]*)\]/g
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/i
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HTML_ANCHOR = /<a\s[^>]*\b(?:id|name)=["']([^"']+)["']/gi

const anchorCache = new Map<string, Set<string>>()

function markdownFiles(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  return output.split('\n').filter(Boolean)
}

// Fenced code blocks hold example links and headings that aren't real, so drop them, keeping the
// line count so a reported line still matches the file.
function withoutCodeBlocks(text: string): string {
  let fence: string | undefined
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (marker && (!fence || marker.startsWith(fence))) {
        fence = fence ? undefined : marker
        return ''
      }
      return fence ? '' : line
    })
    .join('\n')
}

function withoutInlineCode(line: string): string {
  return line.replace(/(`+)[\s\S]*?\1/g, '')
}

/** GitHub's heading slug: the visible text, lowercased, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  const visible = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
  return visible
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-')
}

/**
 * GitHub's duplicate handling (github-slugger): a repeated slug gets the next -N suffix that no
 * earlier heading has taken, counting suffixed slugs too. So `Foo`, `Foo-1`, `Foo` gives foo,
 * foo-1, foo-2, where a per-heading counter would wrongly give the third foo-1 again.
 */
function uniqueSlug(base: string, occurrences: Map<string, number>): string {
  let result = base
  while (occurrences.has(result)) {
    const next = (occurrences.get(base) ?? 0) + 1
    occurrences.set(base, next)
    result = `${base}-${next}`
  }
  occurrences.set(result, 0)
  return result
}

function anchorsIn(file: string): Set<string> {
  const cached = anchorCache.get(file)
  if (cached) return cached
  const text = withoutCodeBlocks(readFileSync(file, 'utf8'))
  const anchors = new Set<string>()
  const occurrences = new Map<string, number>()
  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line)?.[2]
    if (heading !== undefined)
      anchors.add(uniqueSlug(slug(heading), occurrences))
  }
  for (const match of text.matchAll(HTML_ANCHOR)) anchors.add(match[1])
  anchorCache.set(file, anchors)
  return anchors
}

function checkTarget(source: string, target: string): string | undefined {
  const [path, fragment] = target.split('#', 2)
  const resolved = !path
    ? join(REPO_ROOT, source)
    : path.startsWith('/')
      ? join(REPO_ROOT, path)
      : resolve(REPO_ROOT, dirname(source), decodeURIComponent(path))
  if (!existsSync(resolved))
    return `${target}: ${relative(REPO_ROOT, resolved)} doesn't exist`
  const isMarkdown = resolved.endsWith('.md') && statSync(resolved).isFile()
  if (!fragment || !isMarkdown) return undefined
  const anchor = decodeURIComponent(fragment).toLowerCase()
  if (anchorsIn(resolved).has(anchor)) return undefined
  return `${target}: no heading for #${fragment} in ${relative(REPO_ROOT, resolved)}`
}

function targetsIn(line: string): string[] {
  const code = withoutInlineCode(line)
  const inline = [...code.matchAll(INLINE_LINK)].map((match) => match[1])
  const definitions = [...code.matchAll(REFERENCE_DEFINITION)].map(
    (match) => match[2],
  )
  return [...inline, ...definitions].filter(
    (target) => !HAS_SCHEME.test(target),
  )
}

// Reference labels match case-insensitively, with runs of whitespace collapsed.
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

// A usage with no definition renders as literal brackets, not a link.
function undefinedReferences(line: string, labels: Set<string>): string[] {
  return [...withoutInlineCode(line).matchAll(REFERENCE_USAGE)]
    .filter(([, text, label]) => !labels.has(normalizeLabel(label || text)))
    .map(
      ([usage, text, label]) =>
        `${usage}: no definition for [${label || text}]`,
    )
}

function checkFile(source: string): string[] {
  const text = withoutCodeBlocks(readFileSync(join(REPO_ROOT, source), 'utf8'))
  const labels = new Set(
    [...text.matchAll(REFERENCE_DEFINITION)].map((match) =>
      normalizeLabel(match[1]),
    ),
  )
  return text
    .split('\n')
    .flatMap((line, i) =>
      [
        ...targetsIn(line).map((target) => checkTarget(source, target)),
        ...undefinedReferences(line, labels),
      ]
        .filter((problem) => problem !== undefined)
        .map((problem) => `${source}:${i + 1}: ${problem}`),
    )
}

function main(): void {
  const files = markdownFiles()
  const errors = files.flatMap(checkFile)
  for (const error of errors) console.error(`error: ${error}`)
  if (errors.length > 0) process.exit(1)
  console.log(
    `Doc links: all relative links resolve in ${files.length} Markdown files`,
  )
}

main()
