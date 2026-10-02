#!/usr/bin/env node
/**
 * `pnpm run test:lifecycle`: installs the latest GA release from the chart registry, tests it,
 * upgrades it to this checkout's chart, tests again and uninstalls, all on a throwaway kind cluster,
 * then checks the uninstall left nothing behind but what the chart keeps on purpose
 * (portal-template's docs/addon-helm-chart-guidelines.md). The latest GA release is this repo's
 * highest X.Y.Z tag; with none yet, it installs this checkout's chart and upgrades it to itself. CI
 * runs it on pushes to develop and release/** (validate-all.yml).
 *
 * It creates its own cluster with its own kubeconfig, in a temp directory, so it never touches
 * ~/.kube/config or your current context. Needs docker, kind, helm and kubectl, and the
 * client/design-system submodule checked out for the image build.
 *
 * No Portainer runs in the cluster, so the server comes up in its awaiting-setup state: /config,
 * the readiness probe, still answers, which is all a rollout needs.
 *
 * Installs the way Portainer's install flow does (server-ee/api/addons/service.go): the release is
 * named after the add-on id, in the portainer-addon-<id> namespace, with --create-namespace and
 * --take-ownership so Helm adopts the chart's own Namespace, and upgrades with --reset-values.
 * Portainer client-side dry-runs every install and upgrade first (ValidateInstall), where `lookup`
 * returns nothing, so this does too, and fails if the dry run does.
 *
 *   pnpm run test:lifecycle                       # build the image, run, delete the cluster
 *   pnpm run test:lifecycle --image foo:local     # use an image you already built
 *   pnpm run test:lifecycle --keep                # leave the cluster up to poke at
 *
 * Portainer's own flows (Repair, the gateway, the install UI) need a real Portainer, so they stay
 * a manual check.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const ADDON_ID = 'portainer-run'
// Named after the add-on so it never collides with another add-on's lifecycle cluster.
const CLUSTER = `${ADDON_ID}-lifecycle`
const CONTEXT = `kind-${CLUSTER}`
const KUBECONFIG = join(
  mkdtempSync(join(tmpdir(), `${CLUSTER}-`)),
  'kubeconfig',
)
const RELEASE = ADDON_ID
const NAMESPACE = `portainer-addon-${ADDON_ID}`
// The mount path is baked into the client at image build time, so the upgrade proves its values
// rolled out with a ConfigMap entry instead: the chart renders configMap.* generically.
const CONFIG_MAP = 'portainer-run-config'
const UPGRADE_MARKER_KEY = 'LIFECYCLE_UPGRADE'
const UPGRADE_MARKER = 'upgraded'
// Where release.yml publishes GA charts.
const GA_CHART = `oci://ghcr.io/portainer/charts/${ADDON_ID}`
const KEEP_ANNOTATION = 'helm.sh/resource-policy'

// Everything a chart might create, namespaced and cluster-wide, for the leftover check.
const NAMESPACED_KINDS =
  'all,configmap,secret,serviceaccount,role,rolebinding,ingress,networkpolicy,persistentvolumeclaim,poddisruptionbudget'
const CLUSTER_KINDS = 'clusterrole,clusterrolebinding,persistentvolume'

interface KubeObject {
  kind: string
  metadata: { name: string; annotations?: Record<string, string> }
  spec?: {
    volumeClaimTemplates?: { metadata: { name: string } }[]
    persistentVolumeClaimRetentionPolicy?: { whenDeleted?: string }
  }
}

function run(command: string, args: string[], input?: string): string {
  console.log(`$ ${command} ${args.join(' ')}`)
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
  })
}

const helm = (...args: string[]) =>
  run('helm', ['--kubeconfig', KUBECONFIG, '--kube-context', CONTEXT, ...args])
const kubectl = (...args: string[]) =>
  run('kubectl', ['--kubeconfig', KUBECONFIG, '--context', CONTEXT, ...args])
// kind edits the kubeconfig it's given on create and delete, so always give it ours.
const kind = (...args: string[]) =>
  run('kind', [...args, '--name', CLUSTER, '--kubeconfig', KUBECONFIG])

function createCluster(): void {
  const clusters = run('kind', ['get', 'clusters']).split('\n')
  if (clusters.includes(CLUSTER)) kind('delete', 'cluster')
  kind('create', 'cluster', '--wait', '2m')
}

function deleteCluster(): void {
  kind('delete', 'cluster')
  rmSync(resolve(KUBECONFIG, '..'), { recursive: true, force: true })
}

function loadImage(image: string | undefined): string {
  const tag = image ?? `${ADDON_ID}:lifecycle`
  if (!image) run('docker', ['build', '-t', tag, '.'])
  run('kind', ['load', 'docker-image', tag, '--name', CLUSTER])
  return tag
}

function imageValues(image: string): string[] {
  const [repository, tag] = image.split(/:(?=[^:]+$)/)
  return [
    '--set',
    `image.repository=${repository}`,
    '--set',
    `image.tag=${tag}`,
    '--set',
    'image.pullPolicy=Never',
  ]
}

// The latest GA release, or undefined before the first one. release.yml tags every GA release
// X.Y.Z in this repo, so the tags say whether a GA chart must exist; the registry can't, since
// GHCR answers 403 alike for a missing package and a refused one. Once a GA tag exists, failing to
// read its chart fails the test rather than silently upgrading this chart to itself.
function latestGaVersion(): string | undefined {
  const tags = run('git', ['ls-remote', '--tags', '--refs', 'origin'])
    .split('\n')
    .map((line) => /refs\/tags\/v?(\d+)\.(\d+)\.(\d+)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match.slice(1, 4).map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  const latest = tags.at(-1)?.join('.')
  if (!latest) return undefined
  const chart = helm('show', 'chart', GA_CHART, '--version', latest)
  if (!new RegExp(`^version:\\s*${latest}$`, 'm').test(chart)) {
    throw new Error(`${GA_CHART}:${latest} isn't chart version ${latest}`)
  }
  return latest
}

// Installs the GA release when there is one, with its own default image, as a customer has it.
// Otherwise this checkout's chart. Either way after the client-side dry run Portainer does.
function install(image: string, gaVersion: string | undefined): void {
  const source = gaVersion
    ? [GA_CHART, '--version', gaVersion]
    : ['chart/', ...imageValues(image)]
  const args = [
    RELEASE,
    ...source,
    '--namespace',
    NAMESPACE,
    '--create-namespace',
    '--take-ownership',
  ]
  helm('install', ...args, '--dry-run=client')
  helm('install', ...args, '--wait', '--timeout', '3m')
}

// The pod template's config checksum, which changes whenever the ConfigMap does.
function configChecksum(): string {
  return kubectl(
    'get',
    'deployment',
    '--namespace',
    NAMESPACE,
    '--selector',
    `app.kubernetes.io/instance=${RELEASE}`,
    '--output',
    `jsonpath={.items[0].spec.template.metadata.annotations.checksum/config}`,
  )
}

// --reset-values, as the install flow upgrades, so only the values passed here apply.
function upgrade(image: string): void {
  const before = configChecksum()
  const args = [
    RELEASE,
    'chart/',
    '--namespace',
    NAMESPACE,
    '--reset-values',
    '--take-ownership',
    ...imageValues(image),
    '--set',
    `configMap.${UPGRADE_MARKER_KEY}=${UPGRADE_MARKER}`,
  ]
  helm('upgrade', ...args, '--dry-run=client')
  helm('upgrade', ...args, '--wait', '--timeout', '3m')
  const marker = kubectl(
    'get',
    'configmap',
    CONFIG_MAP,
    '--namespace',
    NAMESPACE,
    '--output',
    `jsonpath={.data.${UPGRADE_MARKER_KEY}}`,
  )
  if (marker !== UPGRADE_MARKER) {
    throw new Error(
      `the upgrade didn't apply the new configMap value: ${marker}`,
    )
  }
  if (configChecksum() === before) {
    throw new Error("the upgrade didn't roll the pods onto the new ConfigMap")
  }
}

function helmTest(): void {
  helm('test', RELEASE, '--namespace', NAMESPACE, '--timeout', '2m')
}

// Everything the release created, hooks included, as Helm recorded it. The leftover check reads
// this rather than trusting labels, so an object whose labels the chart got wrong, or that has
// none, is still checked.
function releaseInventory(): string {
  const manifest = helm('get', 'manifest', RELEASE, '--namespace', NAMESPACE)
  const hooks = helm('get', 'hooks', RELEASE, '--namespace', NAMESPACE)
  return `${manifest}\n---\n${hooks}`
}

// The objects from the inventory that exist right now.
function liveObjects(inventory: string): KubeObject[] {
  const found = run(
    'kubectl',
    [
      '--kubeconfig',
      KUBECONFIG,
      '--context',
      CONTEXT,
      'get',
      '--filename',
      '-',
      '--namespace',
      NAMESPACE,
      '--ignore-not-found',
      '--output',
      'json',
    ],
    inventory,
  )
  return parseObjects(found)
}

// kubectl prints a List for several objects, the object alone for one, and nothing for none.
function parseObjects(json: string): KubeObject[] {
  if (!json.trim()) return []
  const parsed = JSON.parse(json) as KubeObject & { items?: KubeObject[] }
  return parsed.items ?? [parsed]
}

const objectName = (object: KubeObject) =>
  `${object.kind.toLowerCase()}/${object.metadata.name}`

interface Claim {
  pattern: RegExp
  retained: boolean
}

// The PVCs a StatefulSet's volumeClaimTemplates create are named <template>-<statefulset>-<n>,
// and outlive it unless its retention policy deletes them.
function statefulSetClaims(objects: KubeObject[]): Claim[] {
  return objects
    .filter((object) => object.kind === 'StatefulSet')
    .flatMap((set) =>
      (set.spec?.volumeClaimTemplates ?? []).map((template) => ({
        pattern: new RegExp(
          `^persistentvolumeclaim/${template.metadata.name}-${set.metadata.name}-\\d+$`,
        ),
        retained:
          set.spec?.persistentVolumeClaimRetentionPolicy?.whenDeleted !==
          'Delete',
      })),
    )
}

// The StatefulSets' PVCs, found by name. A volumeClaimTemplate's labels are the chart's to set, so
// a claim without the release label is invisible to leftovers().
function claimLeftovers(claims: Claim[]): KubeObject[] {
  if (claims.length === 0) return []
  const pvcs = parseObjects(
    kubectl(
      'get',
      'persistentvolumeclaim',
      '--namespace',
      NAMESPACE,
      '--output',
      'json',
    ),
  )
  return pvcs.filter((pvc) =>
    claims.some((claim) => claim.pattern.test(objectName(pvc))),
  )
}

// Objects carrying the release's label, which also finds ones created at runtime and not in the
// inventory, such as the ReplicaSet, its pods and a StatefulSet's PVCs.
function leftovers(): KubeObject[] {
  const selector = `app.kubernetes.io/instance=${RELEASE}`
  const namespaced = kubectl(
    'get',
    NAMESPACED_KINDS,
    '--namespace',
    NAMESPACE,
    '--selector',
    selector,
    '--output',
    'json',
  )
  const clusterWide = kubectl(
    'get',
    CLUSTER_KINDS,
    '--selector',
    selector,
    '--output',
    'json',
  )
  // Helm's own release records, which uninstall must remove too.
  const releases = kubectl(
    'get',
    'secret',
    '--namespace',
    NAMESPACE,
    '--selector',
    `owner=helm,name=${RELEASE}`,
    '--output',
    'json',
  )
  return [namespaced, clusterWide, releases].flatMap(parseObjects)
}

// The claims of the StatefulSets the release has now.
const currentClaims = () => statefulSetClaims(liveObjects(releaseInventory()))

// installedClaims are the claims from before the upgrade: a StatefulSet the upgrade removed or
// renamed is gone, but its retained PVCs are still there.
function uninstallCleanly(installedClaims: Claim[]): void {
  const inventory = releaseInventory()
  const claims = [...installedClaims, ...currentClaims()]
  helm(
    'uninstall',
    RELEASE,
    '--namespace',
    NAMESPACE,
    '--wait',
    '--timeout',
    '2m',
  )
  // Pods belong to the ReplicaSet, not the release, so they can still be shutting down; a pod in
  // its grace period isn't a leftover.
  kubectl(
    'wait',
    '--for=delete',
    'pod',
    '--namespace',
    NAMESPACE,
    '--selector',
    `app.kubernetes.io/instance=${RELEASE}`,
    '--timeout',
    '90s',
  )
  // What the chart keeps on purpose isn't a leftover: anything annotated
  // helm.sh/resource-policy: keep, such as the namespace or an encryption key, and a StatefulSet's
  // retained PVCs. It's listed, so a reviewer can check it's meant to be.
  const kept = new Set<string>()
  const left = new Set<string>()
  const remaining = [
    ...liveObjects(inventory),
    ...leftovers(),
    ...claimLeftovers(claims),
  ]
  for (const object of remaining) {
    const name = objectName(object)
    const keep =
      object.metadata.annotations?.[KEEP_ANNOTATION] === 'keep' ||
      claims.some((claim) => claim.retained && claim.pattern.test(name))
    ;(keep ? kept : left).add(name)
  }
  if (kept.size > 0)
    console.log(`Kept on purpose after uninstall: ${[...kept].join(', ')}`)
  if (left.size > 0)
    throw new Error(`uninstall left resources behind: ${[...left].join(', ')}`)
  // The chart must keep its namespace across uninstall (helm.sh/resource-policy: keep).
  if (!kept.has(`namespace/${NAMESPACE}`))
    throw new Error(`uninstall didn't keep namespace/${NAMESPACE}`)
}

function main(): void {
  const { values } = parseArgs({
    options: {
      image: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  })
  createCluster()
  try {
    const image = loadImage(values.image)
    const gaVersion = latestGaVersion()
    console.log(
      gaVersion
        ? `Upgrading from GA release ${gaVersion}`
        : `No GA release of ${GA_CHART} to upgrade from; upgrading this chart to itself`,
    )
    install(image, gaVersion)
    const installedClaims = currentClaims()
    helmTest()
    upgrade(image)
    helmTest()
    uninstallCleanly(installedClaims)
    console.log(
      'Lifecycle: install, test, upgrade, test and uninstall all succeeded, cleanly',
    )
  } finally {
    if (values.keep)
      console.log(`Kept the cluster; its kubeconfig is ${KUBECONFIG}`)
    else deleteCluster()
  }
}

main()
