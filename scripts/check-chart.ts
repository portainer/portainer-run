#!/usr/bin/env node
/**
 * Checks the Helm chart beyond what `helm lint` covers. `pnpm run lint:chart` runs it; it needs
 * helm on PATH.
 *
 * Every image comes from values: the chart is rendered, test hooks included, with the image
 * pointed at a sentinel registry, and any image that doesn't follow it is hardcoded. Airgapped
 * installs mirror the image and override image.repository, so a hardcoded one can't be pulled
 * (portal-template's docs/addon-helm-chart-guidelines.md).
 *
 * Every manifest matches the Kubernetes schema, strictly, so a typo'd or misplaced field fails
 * here instead of being silently dropped at install. This needs kubeconform on PATH
 * (https://github.com/yannh/kubeconform). Without it the check is skipped locally, but fails in
 * CI, which installs it.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const CHART = 'chart/'
const SENTINEL_REPOSITORY = 'chart-check.invalid/image'
const SENTINEL_TAG = 'check'
const SENTINEL_IMAGE = `${SENTINEL_REPOSITORY}:${SENTINEL_TAG}`

const IMAGE_LINE = /^\s*(?:-\s+)?image:\s*["']?([^"'\s]+)/gm

function helm(args: string[]): string {
  try {
    return execFileSync('helm', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(
        'error: lint:chart needs helm on PATH (https://helm.sh/docs/intro/install/)',
      )
      process.exit(1)
    }
    throw error
  }
}

function validateSchemas(manifests: string): string[] {
  try {
    execFileSync('kubeconform', ['-strict', '-summary', '-'], {
      cwd: REPO_ROOT,
      input: manifests,
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    return []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return [
        `kubeconform found manifests that don't match the Kubernetes schema (see above)`,
      ]
    }
    if (process.env.CI)
      return ['kubeconform is not on PATH; the CI job should install it']
    console.warn(
      'warning: skipped schema validation; install kubeconform to run it (https://github.com/yannh/kubeconform)',
    )
    return []
  }
}

function render(): string {
  return helm([
    'template',
    'chart-check',
    CHART,
    '--set',
    `image.repository=${SENTINEL_REPOSITORY}`,
    '--set',
    `image.tag=${SENTINEL_TAG}`,
  ])
}

function checkImages(manifests: string): string[] {
  const images = [...manifests.matchAll(IMAGE_LINE)].map((match) => match[1])
  if (images.length === 0)
    return ['the rendered chart has no images, so the check found nothing']
  return images
    .filter((image) => image !== SENTINEL_IMAGE)
    .map(
      (image) =>
        `${image} is hardcoded in the chart. Take it from .Values.image so airgapped installs ` +
        `can point it at their mirror.`,
    )
}

function main(): void {
  const manifests = render()
  const errors = [...checkImages(manifests), ...validateSchemas(manifests)]
  for (const error of errors) console.error(`error: ${error}`)
  if (errors.length > 0) process.exit(1)
  console.log(
    'Chart: every image comes from values, and the schema checks passed or were skipped',
  )
}

main()
