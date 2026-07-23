#!/usr/bin/env bun
/**
 * `bun run redeploy` — the helm-mode inner loop in one command.
 *
 * After a code change, getting a locally-built image running in your dev
 * cluster is three manual, error-prone steps (build, load onto the node with a
 * distro-specific command, rollout restart). This collapses them into one:
 *
 *   1. docker build  -> the tag your dev-values.yaml references
 *   2. load the image onto the current cluster's node(s), picking the right
 *      command from your kube-context (kind / minikube / k3d / k3s / shared)
 *   3. kubectl rollout restart the add-on's Deployment so it re-pulls nothing
 *      and just picks up the reloaded image
 *
 * It does NOT install the add-on — do that once from the Addons screen (with
 * DEV_ADDON_CHARTS/DEV_ADDON_VALUES pointing at this repo's chart/ and
 * dev-values.yaml). See portal-template/docs/local-development.md.
 *
 * Usage:
 *   bun run redeploy                     # build the dev-values.yaml image, load, restart
 *   bun run redeploy --image foo:local   # override the tag
 *   bun run redeploy --skip-build        # just reload + restart the existing image
 *   bun run redeploy --dry-run           # print the plan, touch nothing
 *   IMAGE=foo:local bun run redeploy     # tag via env instead of flag
 */
import { $ } from 'bun'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '..')

interface Args {
  image?: string
  skipBuild: boolean
  dryRun: boolean
}

// Where the built image gets loaded, keyed off the current kube-context.
type LoadPlan =
  | { kind: 'kind'; cluster: string }
  | { kind: 'minikube' }
  | { kind: 'k3d'; cluster: string }
  | { kind: 'k3s' }
  | { kind: 'shared'; runtime: string } // shares the host Docker daemon; nothing to load
  | { kind: 'unknown'; context: string }

// A load step: a human-readable label plus the action (null == nothing to run).
interface LoadStep {
  label: string
  run: (() => Promise<void>) | null
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2))

  const id = readAddonId()
  const namespace = `portainer-addon-${id}`
  const selector = `app.kubernetes.io/name=${id}`
  const { image, source } = resolveImage(args, id)

  const context = (await $`kubectl config current-context`.text()).trim()
  const plan = planForContext(context)
  const step = loadStep(image, plan)
  const deployments = await deploymentNames(namespace, selector)

  log('cluster', `context "${context}"  →  namespace ${namespace}`)
  log('image', `${image}  (${source})`)
  console.log('')

  if (args.dryRun) {
    log('plan', 'dry run — nothing will be built, loaded, or restarted')
    log(
      'build',
      args.skipBuild
        ? 'skipped (--skip-build)'
        : `docker build -t ${image} ${REPO_ROOT}`,
    )
    log('load', step.label)
    log(
      'restart',
      deployments.length > 0
        ? deployments.join(', ')
        : `(none found — install "${id}" from the Addons screen first)`,
    )
    return
  }

  // A restart only helps if the add-on is already installed. Check first so we
  // fail with a useful message instead of a bare "No resources found".
  if (deployments.length === 0) {
    fail(
      `No add-on Deployment found in ${namespace} (selector ${selector}).\n` +
        `Install "${id}" once from the Addons screen first — with DEV_ADDON_CHARTS/\n` +
        `DEV_ADDON_VALUES pointing at this repo — then re-run redeploy.`,
    )
  }

  if (!args.skipBuild) {
    log('build', `docker build -t ${image}`)
    await $`docker build -t ${image} ${REPO_ROOT}`
  } else {
    log('build', 'skipped (--skip-build)')
  }

  log('load', step.label)
  if (step.run) await step.run()

  log('restart', deployments.join(', '))
  await $`kubectl rollout restart -n ${namespace} ${deployments}`
  for (const deployment of deployments) {
    await $`kubectl rollout status -n ${namespace} ${deployment} --timeout=120s`
  }

  console.log('')
  log('done', `${image} is live in ${namespace}.`)
}

// --- image loading ---------------------------------------------------------

function loadStep(image: string, plan: LoadPlan): LoadStep {
  switch (plan.kind) {
    case 'kind':
      return {
        label: `kind load docker-image (cluster ${plan.cluster})`,
        run: async () => {
          await $`kind load docker-image ${image} --name ${plan.cluster}`
        },
      }
    case 'minikube':
      return {
        label: 'minikube image load',
        run: async () => void (await $`minikube image load ${image}`),
      }
    case 'k3d':
      return {
        label: `k3d image import (cluster ${plan.cluster})`,
        run: async () =>
          void (await $`k3d image import ${image} -c ${plan.cluster}`),
      }
    case 'k3s':
      // k3s reads from its own containerd, not Docker — pipe a tarball in.
      return {
        label: 'docker save | sudo k3s ctr images import',
        run: async () =>
          void (await $`docker save ${image} | sudo k3s ctr images import -`),
      }
    case 'shared':
      return {
        label: `skipped — ${plan.runtime} shares the host Docker daemon`,
        run: null,
      }
    case 'unknown':
      return {
        label:
          `skipped — unrecognized context "${plan.context}".\n` +
          `             If pods come up ImagePullBackOff, load it manually (e.g.\n` +
          `             \`kind load docker-image ${image}\`) or push to a registry and\n` +
          `             set image.pullPolicy: Always in dev-values.yaml.`,
        run: null,
      }
  }
}

// --- helpers ---------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const args: Args = { skipBuild: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--image') {
      args.image = argv[++i]
    } else if (arg === '--skip-build') {
      args.skipBuild = true
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else {
      fail(`Unknown argument: ${arg}`)
    }
  }
  return args
}

// The add-on id is the chart name, which also drives the namespace
// (portainer-addon-<id>) and the pods' app.kubernetes.io/name label.
function readAddonId(): string {
  const chart = readFileSync(resolve(REPO_ROOT, 'chart/Chart.yaml'), 'utf8')
  const match = chart.match(/^name:\s*(\S+)/m)
  if (!match) fail('Could not read chart name from chart/Chart.yaml')
  return match![1]
}

// Resolve which image tag to build. Explicit flag/env win; otherwise use the
// exact ref from dev-values.yaml so the built tag always matches what the
// install actually runs. Falls back to <id>:dev if no dev-values.yaml.
function resolveImage(
  args: Args,
  id: string,
): { image: string; source: string } {
  if (args.image) return { image: normalizeTag(args.image), source: '--image' }
  if (process.env.IMAGE)
    return { image: normalizeTag(process.env.IMAGE), source: '$IMAGE' }
  const fromValues = readImageFromDevValues()
  if (fromValues) return { image: fromValues, source: 'dev-values.yaml' }
  return { image: `${id}:dev`, source: 'default' }
}

function readImageFromDevValues(): string | null {
  const path = resolve(REPO_ROOT, 'dev-values.yaml')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  // Scope to the image: block (its indented lines up to the next top-level key).
  const block = text.match(/^image:\n((?:[ \t]+.*\n?)*)/m)?.[1]
  if (!block) return null
  const repository = block.match(/^\s+repository:\s*['"]?([^'"\s#]+)/m)?.[1]
  const tag = block.match(/^\s+tag:\s*['"]?([^'"\s#]+)/m)?.[1]
  if (!repository) return null
  return tag ? `${repository}:${tag}` : repository
}

// A bare "foo" is ambiguous to Docker (implies :latest); pin our dev tag.
function normalizeTag(image: string): string {
  return image.includes(':') ? image : `${image}:dev`
}

async function deploymentNames(
  namespace: string,
  selector: string,
): Promise<string[]> {
  const out =
    await $`kubectl get deployment -n ${namespace} -l ${selector} -o name`
      .nothrow()
      .text()
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function planForContext(context: string): LoadPlan {
  if (context.startsWith('kind-'))
    return { kind: 'kind', cluster: context.slice('kind-'.length) }
  if (context.startsWith('k3d-'))
    return { kind: 'k3d', cluster: context.slice('k3d-'.length) }
  if (context === 'minikube') return { kind: 'minikube' }
  if (context === 'default' || context.includes('k3s')) return { kind: 'k3s' }
  const sharedRuntimes = [
    'docker-desktop',
    'rancher-desktop',
    'orbstack',
    'colima',
  ]
  if (sharedRuntimes.includes(context))
    return { kind: 'shared', runtime: context }
  return { kind: 'unknown', context }
}

function log(tag: string, message: string) {
  console.log(`  \x1b[36m▸ ${tag.padEnd(8)}\x1b[0m ${message}`)
}

function fail(message: string): never {
  console.error(`\n  \x1b[31m✗ ${message}\x1b[0m\n`)
  process.exit(1)
}

await main()
