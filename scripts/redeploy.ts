#!/usr/bin/env node
/**
 * `pnpm run redeploy` — build the add-on image, load it onto the current cluster's
 * nodes (kind / minikube / k3d / k3s / microk8s / a shared daemon), and rollout
 * restart the Deployment. One command instead of three manual, distro-specific ones.
 *
 * Does NOT install the add-on — do that once from the Addons screen with
 * DEV_ADDON_CHARTS/DEV_ADDON_VALUES set. See docs/developing-inside-portainer.md
 * in the portal-template repo.
 *
 *   pnpm run redeploy                     # build the dev-values.yaml image, load, restart
 *   pnpm run redeploy --image foo:local   # override the tag (or IMAGE=foo:local)
 *   pnpm run redeploy --skip-build        # reload + restart the existing image
 *   pnpm run redeploy --dry-run           # print the plan, touch nothing
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')

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
  | { kind: 'microk8s' }
  | { kind: 'shared'; runtime: string } // shares the host Docker daemon; nothing to load
  | { kind: 'unknown'; context: string }

// A load step: a human-readable label plus the action (null == nothing to run).
interface LoadStep {
  label: string
  run: (() => void) | null
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  const id = readAddonId()
  const namespace = `portainer-addon-${id}`
  const selector = `app.kubernetes.io/name=${id}`
  if (!args.dryRun) ensureDevValues()
  const { image, source } = resolveImage(args, id)

  const context = execFileSync('kubectl', ['config', 'current-context'], {
    encoding: 'utf8',
  }).trim()
  const step = loadStep(image, planForContext(context))
  const deployments = deploymentNames(namespace, selector)
  const mismatched = deploymentImages(namespace, deployments).filter(
    (d) => d.image !== image,
  )

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
        : '(not installed yet — build and load only)',
    )
    for (const d of mismatched) {
      log(
        'stale',
        `${d.name} runs ${d.image} — a restart would not pick up ${image}`,
      )
    }
    return
  }

  // A restart only reloads the image the Deployment already references. Installed
  // without DEV_ADDON_VALUES it still points at the published image, so the
  // restart succeeds, a new pod starts, and the old build is served — the one
  // failure here with no visible symptom. Checked before building so it costs
  // seconds rather than a full image build.
  if (mismatched.length > 0) {
    fail(
      `${mismatched.map((d) => `${d.name} runs ${d.image}`).join('\n')}\n` +
        `but this builds ${image}, so a restart would redeploy the same image.\n\n` +
        `Reinstall "${id}" from the Addons screen with DEV_ADDON_CHARTS/\n` +
        `DEV_ADDON_VALUES pointing at this repo, so the release runs your build.`,
    )
  }

  if (!args.skipBuild) {
    log('build', `docker build -t ${image}`)
    execFileSync('docker', ['build', '-t', image, REPO_ROOT], {
      stdio: 'inherit',
    })
  } else {
    log('build', 'skipped (--skip-build)')
  }

  log('load', step.label)
  step.run?.()

  // Before the first install there is nothing to restart, and the image has to be
  // on the node already: the release pins this tag with IfNotPresent, so a kubelet
  // that cannot find it falls back to a registry that has no such image.
  if (deployments.length === 0) {
    log('install', `image ready — "${id}" is not installed yet`)
    console.log(
      `\n  Install it from the Addons screen, with DEV_ADDON_CHARTS and\n` +
        `  DEV_ADDON_VALUES pointing at this repo. Then re-run redeploy per change.\n`,
    )
    return
  }

  log('restart', deployments.join(', '))
  execFileSync(
    'kubectl',
    ['rollout', 'restart', '-n', namespace, ...deployments],
    { stdio: 'inherit' },
  )
  for (const deployment of deployments) {
    execFileSync(
      'kubectl',
      ['rollout', 'status', '-n', namespace, deployment, '--timeout=120s'],
      { stdio: 'inherit' },
    )
  }

  console.log('')
  log('done', `${image} is live in ${namespace}.`)
}

// --- steps -----------------------------------------------------------------

function loadStep(image: string, plan: LoadPlan): LoadStep {
  switch (plan.kind) {
    case 'kind':
      return {
        label: `kind load docker-image (cluster ${plan.cluster})`,
        run: () =>
          execFileSync(
            'kind',
            ['load', 'docker-image', image, '--name', plan.cluster],
            { stdio: 'inherit' },
          ),
      }
    case 'minikube': {
      // Not `minikube image load`: it silently keeps the node's old image when
      // the tag already exists there (--overwrite included, as of v1.38), and
      // `minikube image rm` is refused while a pod still runs the image. Piping
      // into the node's runtime re-points the tag unconditionally.
      const importCmd = minikubeImportCommand()
      return {
        label: `docker save | minikube ssh ${importCmd}`,
        run: () =>
          execFileSync(
            `docker save ${shQuote(image)} | minikube ssh --native-ssh=false -- ${shQuote(importCmd)}`,
            { shell: true, stdio: 'inherit' },
          ),
      }
    }
    case 'k3d':
      return {
        label: `k3d image import (cluster ${plan.cluster})`,
        run: () =>
          execFileSync('k3d', ['image', 'import', image, '-c', plan.cluster], {
            stdio: 'inherit',
          }),
      }
    case 'microk8s':
      // microk8s has its own containerd too; `microk8s ctr` wraps it with the
      // right socket and namespace.
      return {
        label: 'docker save | microk8s ctr images import',
        run: () =>
          execFileSync(
            `docker save ${shQuote(image)} | microk8s ctr images import -`,
            { shell: true, stdio: 'inherit' },
          ),
      }
    case 'k3s':
      // k3s reads from its own containerd, not Docker — pipe a tarball in.
      return {
        label: 'docker save | sudo k3s ctr images import',
        run: () =>
          execFileSync(
            `docker save ${shQuote(image)} | sudo k3s ctr images import -`,
            { shell: true, stdio: 'inherit' },
          ),
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
    // `pnpm run redeploy -- --dry-run` forwards the separator; npm strips it.
    if (arg === '--') {
      continue
    } else if (arg === '--image') {
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

// A bare "foo" is ambiguous to Docker (implies :latest); pin our local tag.
function normalizeTag(image: string): string {
  return image.includes(':') ? image : `${image}:local`
}

function deploymentNames(namespace: string, selector: string): string[] {
  let out: string
  try {
    out = execFileSync(
      'kubectl',
      ['get', 'deployment', '-n', namespace, '-l', selector, '-o', 'name'],
      { encoding: 'utf8' },
    )
  } catch {
    out = ''
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

// The image each Deployment actually runs. Read straight from the cluster: it is
// the only thing that says whether a restart would pick up a local build.
function deploymentImages(
  namespace: string,
  deployments: string[],
): { name: string; image: string }[] {
  return deployments.map((name) => ({
    name,
    image: execFileSync(
      'kubectl',
      [
        'get',
        name,
        '-n',
        namespace,
        '-o',
        'jsonpath={.spec.template.spec.containers[0].image}',
      ],
      { encoding: 'utf8' },
    ).trim(),
  }))
}

function planForContext(context: string): LoadPlan {
  if (context.startsWith('kind-'))
    return { kind: 'kind', cluster: context.slice('kind-'.length) }
  if (context.startsWith('k3d-'))
    return { kind: 'k3d', cluster: context.slice('k3d-'.length) }
  if (context === 'minikube') return { kind: 'minikube' }
  if (context.includes('microk8s')) return { kind: 'microk8s' }
  // k3s names its context "default" unless the kubeconfig was merged/renamed.
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

// The in-node command that reads an image tarball from stdin, per minikube
// container runtime ("docker://…", "containerd://…", "cri-o://…").
function minikubeImportCommand(): string {
  let runtime = ''
  try {
    runtime = execFileSync(
      'kubectl',
      [
        'get',
        'nodes',
        '-o',
        'jsonpath={.items[0].status.nodeInfo.containerRuntimeVersion}',
      ],
      { encoding: 'utf8' },
    ).trim()
  } catch {
    // fall through to the containerd default
  }
  if (runtime.startsWith('docker')) return 'docker load'
  if (runtime.startsWith('cri-o')) return 'sudo podman load'
  return 'sudo ctr -n k8s.io images import -'
}

// Resolve which image tag to build. Explicit flag/env win; otherwise use the
// exact ref from dev-values.yaml so the built tag always matches what the
// install actually runs. Falls back to <id>:local if no dev-values.yaml.
function resolveImage(
  args: Args,
  id: string,
): { image: string; source: string } {
  if (args.image) return { image: normalizeTag(args.image), source: '--image' }
  if (process.env.IMAGE)
    return { image: normalizeTag(process.env.IMAGE), source: '$IMAGE' }
  const fromValues = readImageFromDevValues()
  if (fromValues) return { image: fromValues, source: 'dev-values.yaml' }
  return { image: `${id}:local`, source: 'default' }
}

// The install reads dev-values.yaml for the image tag, so seed it from the example
// rather than have the first run build a tag the release will not reference.
function ensureDevValues() {
  const path = resolve(REPO_ROOT, 'dev-values.yaml')
  const example = resolve(REPO_ROOT, 'dev-values.yaml.example')
  if (existsSync(path) || !existsSync(example)) return

  copyFileSync(example, path)
  log('values', 'created dev-values.yaml from the example — edit it to taste')
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

// Single-quote for embedding in a `shell: true` command string.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function log(tag: string, message: string) {
  console.log(`  \x1b[36m▸ ${tag.padEnd(8)}\x1b[0m ${message}`)
}

function fail(message: string): never {
  console.error(`\n  \x1b[31m✗ ${message}\x1b[0m\n`)
  process.exit(1)
}

main()
