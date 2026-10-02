#!/usr/bin/env node
/**
 * Checks every production dependency's license against Portainer's FOSS policy, and optionally
 * writes the third-party notices the image ships with. `pnpm run lint:deep` runs the check;
 * `pnpm run build` runs it with --notices.
 *
 *   node scripts/check-licenses.ts                                    # check only
 *   node scripts/check-licenses.ts --notices build/THIRD_PARTY_NOTICES.txt
 *   node scripts/check-licenses.ts --release                          # pending fails too
 *
 * Only production dependencies count: devDependencies run at build time and never ship. Anything
 * that isn't a Green license needs an entry in third-party-licenses.json, approved by the FOSSCC.
 * An entry still `pending` approval only warns, so day-to-day CI keeps working while the FOSSCC
 * decides. release.yml runs --release before a GA release, where it's an error, so nothing pending
 * ships in a GA image.
 */
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const CONFIG_FILE = 'third-party-licenses.json'

// Portainer's FOSS Table of Licenses, "FOSS distributed as components or libraries":
// https://app.notion.com/p/a021b88d08f84143a9ceb583277b5d7a
// Green licenses can be used without asking the FOSSCC. Orange and Red ones are listed so a
// failure says which category it hit; any license not listed needs the FOSSCC too.
const GREEN = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'AFL-2.1',
  'CC0-1.0',
  'CC-BY-4.0',
])
const ORANGE = new Set(['LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later'])
const RED = new Set([
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
])
const OPERATORS = new Set(['AND', 'OR', 'WITH', '(', ')'])

// LICENSE, LICENCE.md, COPYING, NOTICE and the like, at a package's root.
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i

type Status = 'approved' | 'pending'

// A package whose license isn't Green, allowed by the FOSSCC. Pinned to the license it was
// approved for, so a relicensed version fails again.
interface PackageException {
  license: string
  status: Status
  reason: string
}

// Third-party files committed to the repo rather than installed, e.g. self-hosted fonts.
// pnpm can't see them, so they're listed here for the notices; a non-Green one needs a status.
interface BundledFiles {
  name: string
  path: string
  license: string
  licenseFile: string
  status?: Status
  reason?: string
}

interface Config {
  exceptions: Record<string, PackageException>
  bundledFiles: BundledFiles[]
}

// One installed version of a package, flattened from `pnpm licenses list --json`.
interface Installed {
  name: string
  version: string
  path: string
  license: string
  homepage?: string
}

interface PnpmLicenseEntry {
  name: string
  versions: string[]
  paths: string[]
  homepage?: string
}

interface Report {
  errors: string[]
  warnings: string[]
  // --release: a pending approval is an error, not a warning.
  release: boolean
}

function listProductionPackages(): Installed[] {
  const output = execFileSync(
    'pnpm',
    ['licenses', 'list', '--prod', '--json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  )
  // pnpm prints a plain message instead of JSON when there are no dependencies.
  if (!output.trimStart().startsWith('{')) return []
  const byLicense = JSON.parse(output) as Record<string, PnpmLicenseEntry[]>
  return Object.entries(byLicense).flatMap(([license, entries]) =>
    entries.flatMap((entry) =>
      entry.versions.map((version, i) => ({
        name: entry.name,
        version,
        path: entry.paths[i],
        license,
        homepage: entry.homepage,
      })),
    ),
  )
}

/**
 * Whether an SPDX expression is satisfiable with Green licenses alone: an OR needs one Green
 * side, an AND needs both. `X WITH <exception>` isn't in the policy table, so it never passes.
 * Anything malformed fails: an unbalanced parenthesis, a missing operand, or a token left over.
 */
function isGreen(expression: string): boolean {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/)
  let pos = 0
  const malformed = new Error('malformed SPDX expression')
  const atom = (): boolean => {
    const token = tokens[pos++]
    if (token === '(') {
      const value = anyOf()
      if (tokens[pos++] !== ')') throw malformed
      return value
    }
    if (token === undefined || OPERATORS.has(token)) throw malformed
    if (tokens[pos] === 'WITH') {
      const exception = tokens[pos + 1]
      if (exception === undefined || OPERATORS.has(exception)) throw malformed
      pos += 2
      return false
    }
    return GREEN.has(token)
  }
  const allOf = (): boolean => {
    let value = atom()
    while (tokens[pos] === 'AND') {
      pos++
      value = atom() && value
    }
    return value
  }
  const anyOf = (): boolean => {
    let value = allOf()
    while (tokens[pos] === 'OR') {
      pos++
      value = allOf() || value
    }
    return value
  }
  try {
    const value = anyOf()
    return pos === tokens.length && value
  } catch {
    return false
  }
}

function category(id: string): string {
  if (GREEN.has(id)) return 'Green'
  if (ORANGE.has(id)) return 'Orange'
  if (RED.has(id)) return 'Red'
  return 'not in the FOSS table'
}

function describe(expression: string): string {
  const ids = expression.split(/[\s()]+/).filter((t) => t && !OPERATORS.has(t))
  return ids.map((id) => `${id}: ${category(id)}`).join(', ')
}

function reportPending(
  report: Report,
  subject: string,
  license: string,
  reason: string | undefined,
): void {
  const why = reason ?? 'no reason given'
  if (report.release) {
    report.errors.push(
      `${subject} (${license}) is still pending FOSSCC approval, so a GA release can't ship it. ` +
        `Get the approval and mark it approved in ${CONFIG_FILE}, or remove it. Pending: ${why}`,
    )
  } else {
    report.warnings.push(
      `${subject} (${license}) is allowed pending FOSSCC approval: ${why}`,
    )
  }
}

function checkPackage(pkg: Installed, config: Config, report: Report): void {
  if (isGreen(pkg.license)) return
  const id = `${pkg.name}@${pkg.version}`
  const exception = config.exceptions[pkg.name]
  if (!exception) {
    report.errors.push(
      `${id} is licensed ${pkg.license} (${describe(pkg.license)}). Remove it, or get FOSSCC ` +
        `approval and add it to ${CONFIG_FILE}'s exceptions.`,
    )
  } else if (exception.license !== pkg.license) {
    report.errors.push(
      `${id} is now licensed ${pkg.license}, but its exception in ${CONFIG_FILE} covers ` +
        `${exception.license}. It needs FOSSCC approval again.`,
    )
  } else if (exception.status === 'pending') {
    reportPending(report, id, pkg.license, exception.reason)
  }
}

function checkStaleExceptions(
  packages: Installed[],
  config: Config,
  report: Report,
): void {
  const names = new Set(packages.map((p) => p.name))
  for (const name of Object.keys(config.exceptions)) {
    if (!names.has(name)) {
      report.errors.push(
        `${CONFIG_FILE} has an exception for ${name}, which is no longer a production ` +
          `dependency. Remove the exception.`,
      )
    }
  }
}

function checkBundledFiles(config: Config, report: Report): void {
  for (const files of config.bundledFiles) {
    if (isGreen(files.license)) continue
    if (files.status === 'pending') {
      reportPending(report, files.name, files.license, files.reason)
    } else if (files.status !== 'approved') {
      report.errors.push(
        `${files.name} (${files.path}) is licensed ${files.license} (${describe(files.license)}), ` +
          `so its entry in ${CONFIG_FILE} needs a status and the FOSSCC's approval.`,
      )
    }
  }
}

function licenseTexts(dir: string): string[] {
  return readdirSync(dir)
    .filter(
      (file) => LICENSE_FILE.test(file) && statSync(join(dir, file)).isFile(),
    )
    .sort()
    .map((file) => readFileSync(join(dir, file), 'utf8').trim())
}

function packageNotice(pkg: Installed, report: Report): string {
  const header = [`${pkg.name}@${pkg.version}`, `License: ${pkg.license}`]
  if (pkg.homepage) header.push(`Homepage: ${pkg.homepage}`)
  const texts = licenseTexts(pkg.path)
  if (texts.length === 0) {
    report.warnings.push(
      `${pkg.name}@${pkg.version} ships no license file; its notice links to it.`,
    )
    texts.push(
      `The package ships no license file. See ${pkg.homepage ?? 'its npm page'}.`,
    )
  }
  return [header.join('\n'), ...texts].join('\n\n')
}

function filesNotice(files: BundledFiles): string {
  const header = `${files.name} (${files.path})\nLicense: ${files.license}`
  const text = readFileSync(join(REPO_ROOT, files.licenseFile), 'utf8').trim()
  return `${header}\n\n${text}`
}

function writeNotices(
  target: string,
  packages: Installed[],
  config: Config,
  report: Report,
): void {
  const sorted = [...packages].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  )
  const sections = [
    ...sorted.map((pkg) => packageNotice(pkg, report)),
    ...config.bundledFiles.map(filesNotice),
  ]
  const intro =
    'This software includes the following third-party components, each under its own license.'
  const path = resolve(REPO_ROOT, target)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${intro}\n\n${sections.join(`\n\n${'='.repeat(80)}\n\n`)}\n`,
  )
  console.log(
    `Licenses: wrote notices for ${sections.length} components to ${target}`,
  )
}

function summary(packages: Installed[]): string {
  const counts = new Map<string, number>()
  for (const pkg of packages)
    counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1)
  const breakdown = [...counts]
    .map(([license, n]) => `${license} ${n}`)
    .join(', ')
  return `Licenses: ${packages.length} production packages (${breakdown})`
}

function main(): void {
  const { values } = parseArgs({
    options: {
      notices: { type: 'string' },
      release: { type: 'boolean', default: false },
    },
  })
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, CONFIG_FILE), 'utf8'),
  ) as Config
  const packages = listProductionPackages()
  const report: Report = {
    errors: [],
    warnings: [],
    release: values.release,
  }

  for (const pkg of packages) checkPackage(pkg, config, report)
  checkStaleExceptions(packages, config, report)
  checkBundledFiles(config, report)
  console.log(summary(packages))

  if (report.errors.length === 0 && values.notices) {
    writeNotices(values.notices, packages, config, report)
  }
  for (const warning of report.warnings) console.warn(`warning: ${warning}`)
  for (const error of report.errors) console.error(`error: ${error}`)
  if (report.errors.length > 0) process.exit(1)
}

main()
