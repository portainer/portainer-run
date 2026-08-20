// ---------------------------------------------------------------------------
// Runtime catalogue — THE single source of truth for how each runtime deploys.
//
// Consumed by every deploy path:
//   - the browser UI  (client/src/pages/deploy/runtimes.ts re-exports this)
//   - the MCP server  (server/routes/mcp.js)
//   - the deploy pipeline that builds the manifests (server/routes/vibe.js)
//
// This file is plain JavaScript on purpose: the server runs it directly with
// no build step, and the client bundles it through the `@shared` alias. Adding
// a runtime, or changing an image, port, install step or capability grant, is a
// single edit here and every path picks it up.
//
// Everything a runtime needs to deploy lives on its entry. Resist the pull to
// re-add a `switch (runtime)` in a caller — that is exactly how the nginx image
// drifted between the UI and MCP (#88).
// ---------------------------------------------------------------------------

const STATIC_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.ts',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp4',
  '.webm',
  '.mp3',
  '.ogg',
  '.pdf',
  '.txt',
  '.md',
  '.xml',
  '.csv',
])

function isStaticFile(name) {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && STATIC_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

// Some runtime images de-privilege at startup: they start as root, chown their
// working/cache dirs to a worker user, and bind a privileged port. With ALL
// capabilities dropped they fail at boot ("Operation not permitted" on chown).
// nginx avoids this by using the unprivileged image; php-apache has no clean
// unprivileged official image, so it is granted back the minimum capabilities
// it needs via `needsCaps`. See #39.
export const WEBSERVER_RUNTIME_CAPS = [
  'CHOWN',
  'SETUID',
  'SETGID',
  'NET_BIND_SERVICE',
]

/**
 * @typedef {object} RuntimeDef
 * @property {string} id
 * @property {string} label            Human-readable name for the UI.
 * @property {string} image            Container image to run.
 * @property {number} port             Port the app is expected to listen on.
 * @property {string} workDir          Absolute path the source is synced to.
 * @property {boolean} [needsCaps]     Grant WEBSERVER_RUNTIME_CAPS (see #39).
 * @property {(names: string[]) => boolean} [detect]
 * @property {(files: {name: string, text: string}[]) => string} defaultCmd
 * @property {(workDir: string) => string|null} [installCmd]
 * @property {(workDir: string) => {name: string, value: string}[]} [env]
 */

/** @type {RuntimeDef} */
const NGINX_RUNTIME = {
  id: 'nginx',
  label: 'nginx (static)',
  // Unprivileged NGINX: runs as UID 101, listens on 8080, and moves its PID and
  // temp paths to /tmp, so it needs no Linux capabilities at startup. Required
  // because all pods drop ALL capabilities under our pod security baseline (#39).
  // Note: a custom nginx.conf must include `pid /tmp/nginx.pid`.
  image: 'nginxinc/nginx-unprivileged:alpine',
  defaultCmd: () => "nginx -g 'daemon off;'",
  port: 8080,
  workDir: '/usr/share/nginx/html',
  // Static sites have nothing to install.
  installCmd: () => null,
}

/** @type {RuntimeDef[]} */
const RUNTIMES = [
  {
    id: 'node',
    label: 'Node.js 22',
    image: 'node:22',
    detect: (names) => {
      const base = names.map((n) => n.split('/').pop())
      return base.includes('package.json') || base.includes('server.js')
    },
    defaultCmd: (files) => {
      const pkg = files.find((f) => f.name === 'package.json')
      if (pkg) {
        try {
          const parsed = JSON.parse(pkg.text)
          if (parsed?.scripts?.start) return 'npm start'
        } catch {
          /* ignore */
        }
      }
      const hasServerJs = files.some(
        (f) => f.name === 'server.js' || f.name === 'index.js',
      )
      return hasServerJs
        ? `node ${files.find((f) => f.name === 'server.js') ? 'server.js' : 'index.js'}`
        : 'npm start'
    },
    port: 3000,
    workDir: '/app',
    // npm installs node_modules into the working directory, which is on the PV.
    //
    // When a dependency has no prebuilt binary for this runtime's ABI, npm
    // compiles it with node-gyp, which by default downloads the Node headers
    // tarball and extracts it. That extraction is the fragile step: tar
    // preserves ownership and mtime when running as uid 0, and both need
    // capabilities this pod deliberately drops. Pointing node-gyp at headers
    // already present in the image makes it skip the download and extraction
    // altogether, which also removes a build-time dependency on reaching
    // nodejs.org (relevant for air-gapped clusters). Official images ship the
    // headers under /usr/local/include/node; the guard means any image that
    // does not simply falls back to the download path.
    installCmd: (workDir) =>
      `cd ${workDir} && if [ -f package.json ]; then ` +
      `if [ -f /usr/local/include/node/common.gypi ]; then export npm_config_nodedir=/usr/local; fi; ` +
      `npm install --omit=dev 2>&1; fi`,
  },
  {
    id: 'python',
    label: 'Python 3.13',
    image: 'python:3.13-slim',
    detect: (names) =>
      names.includes('requirements.txt') ||
      names.some((n) => n.endsWith('.py')),
    defaultCmd: (files) => {
      for (const candidate of ['main.py', 'app.py', 'server.py', 'run.py']) {
        if (files.some((f) => f.name === candidate))
          return `python ${candidate}`
      }
      return 'python app.py'
    },
    port: 8000,
    workDir: '/app',
    // pip's default target is the image's system site-packages, which live
    // OUTSIDE the shared PV and so are lost when the init container exits.
    // Install into a PV-local directory instead (libraries + console scripts
    // under ${workDir}/.pydeps and ${workDir}/.pydeps/bin) so the main
    // container can see them via the PYTHONPATH/PATH set in `env`.
    installCmd: (workDir) =>
      `cd ${workDir} && if [ -f requirements.txt ]; then pip install --no-cache-dir --target=${workDir}/.pydeps -r requirements.txt; fi`,
    env: (workDir) => [
      { name: 'PYTHONPATH', value: `${workDir}/.pydeps` },
      {
        name: 'PATH',
        value: `${workDir}/.pydeps/bin:/usr/local/bin:/usr/bin:/bin`,
      },
    ],
  },
  {
    id: 'php',
    label: 'PHP 8.4',
    image: 'php:8.4-apache',
    detect: (names) => names.some((n) => n.endsWith('.php')),
    defaultCmd: () => 'apache2-foreground',
    port: 80,
    workDir: '/var/www/html',
    // php-apache starts as root, chowns its dirs and binds port 80. There is no
    // clean unprivileged official image, so this runtime is a deliberate,
    // scoped exception to the drop-ALL baseline (see #39 and the note above).
    needsCaps: true,
    // composer installs vendor/ into the working directory, which is on the PV.
    installCmd: (workDir) =>
      `cd ${workDir} && if [ -f composer.json ] && command -v composer > /dev/null 2>&1; then composer install --no-dev --optimize-autoloader --no-interaction; fi`,
  },
  {
    id: 'ruby',
    label: 'Ruby 3.4',
    image: 'ruby:3.4-slim',
    detect: (names) =>
      names.includes('Gemfile') || names.some((n) => n.endsWith('.rb')),
    defaultCmd: (files) => {
      for (const candidate of ['app.rb', 'server.rb', 'config.ru']) {
        if (files.some((f) => f.name === candidate)) {
          return candidate === 'config.ru'
            ? 'bundle exec rackup -p 9292 -o 0.0.0.0'
            : `ruby ${candidate}`
        }
      }
      return 'bundle exec ruby app.rb'
    },
    port: 9292,
    workDir: '/app',
    // Same problem as pip: the default gem install location is outside the PV.
    // Vendor gems into a PV-local path so they persist into the main container.
    installCmd: (workDir) =>
      `cd ${workDir} && if [ -f Gemfile ]; then bundle config set --local path '${workDir}/.bundle' && bundle install; fi`,
    env: (workDir) => [
      { name: 'BUNDLE_PATH', value: `${workDir}/.bundle` },
      { name: 'BUNDLE_GEMFILE', value: `${workDir}/Gemfile` },
      { name: 'GEM_HOME', value: `${workDir}/.bundle` },
      { name: 'GEM_PATH', value: `${workDir}/.bundle` },
      {
        name: 'PATH',
        value: `${workDir}/.bundle/bin:/usr/local/bundle/bin:/usr/local/bin:/usr/bin:/bin`,
      },
    ],
  },
]

/** Detectable runtimes plus nginx, which is only ever the fallback or forced. */
export const ALL_RUNTIMES = [...RUNTIMES, NGINX_RUNTIME]

/** Runtime ids accepted as an explicit override, for MCP schemas and validation. */
export const RUNTIME_IDS = ALL_RUNTIMES.map((r) => r.id)

/** Look a runtime up by id. Returns undefined when unknown. */
export function getRuntime(id) {
  return ALL_RUNTIMES.find((r) => r.id === id)
}

/**
 * Detect the runtime for a set of files.
 * @param {{name: string, text: string}[]} files
 * @returns {RuntimeDef}
 */
export function detectRuntime(files) {
  const names = files.map((f) => f.name)
  for (const rt of RUNTIMES) {
    if (rt.detect?.(names)) return rt
  }
  // Static site: every file is a static asset. The no-match case lands here
  // too — nginx is the safe fallback either way.
  const nonEnv = files.filter((f) => !f.name.endsWith('.env.example'))
  if (nonEnv.length > 0 && nonEnv.every((f) => isStaticFile(f.name))) {
    return NGINX_RUNTIME
  }
  return NGINX_RUNTIME
}

/**
 * Resolve a runtime, honouring an explicit override.
 * @param {{name: string, text: string}[]} files
 * @param {string} [forcedId] A runtime id, or 'auto'/falsy to detect.
 * @returns {RuntimeDef}
 */
export function resolveRuntime(files, forcedId) {
  if (!forcedId || forcedId === 'auto') return detectRuntime(files)
  const rt = getRuntime(forcedId)
  if (!rt)
    throw new Error(
      `Unknown runtime "${forcedId}" — use one of: ${RUNTIME_IDS.join(', ')}`,
    )
  return rt
}

/**
 * The install command for a runtime, or null when there is nothing to install.
 * Unknown ids yield null so an unrecognised runtime skips the install step
 * rather than failing the deploy.
 */
export function installCommandFor(runtimeId, workDir) {
  return getRuntime(runtimeId)?.installCmd?.(workDir) ?? null
}

/** Env vars the main container needs to find PV-installed dependencies. */
export function runtimeEnvFor(runtimeId, workDir) {
  return getRuntime(runtimeId)?.env?.(workDir) ?? []
}

/** Whether this runtime gets the scoped capability grant (see #39). */
export function runtimeNeedsCaps(runtimeId) {
  return getRuntime(runtimeId)?.needsCaps === true
}

/**
 * The port a runtime listens on, used as the fallback when a caller does not
 * pass one explicitly. Defaults to nginx's port for unknown runtimes, matching
 * the detection fallback.
 */
export function defaultPortFor(runtimeId) {
  return getRuntime(runtimeId)?.port ?? NGINX_RUNTIME.port
}

/** The default workDir for a runtime, for the same fallback reason as the port. */
export function defaultWorkDirFor(runtimeId) {
  return getRuntime(runtimeId)?.workDir ?? '/app'
}
