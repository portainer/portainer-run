// ---------------------------------------------------------------------------
// Runtime detection
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

function isStaticFile(name: string) {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && STATIC_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

export interface RuntimeDef {
  id: string
  label: string
  image: string
  detect?: (names: string[]) => boolean
  defaultCmd: (files: { name: string; text: string }[]) => string
  port: number
  workDir: string
}

const NGINX_RUNTIME: RuntimeDef = {
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
}

const RUNTIMES: RuntimeDef[] = [
  {
    id: 'node',
    label: 'Node.js 22',
    image: 'node:22',
    detect: (names) => {
      const base = names.map((n) => n.split('/').pop() as string)
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
  },
  {
    id: 'php',
    label: 'PHP 8.4',
    image: 'php:8.4-apache',
    detect: (names) => names.some((n) => n.endsWith('.php')),
    defaultCmd: () => 'apache2-foreground',
    port: 80,
    workDir: '/var/www/html',
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
  },
]

export function detectRuntime(
  files: { name: string; text: string }[],
): RuntimeDef {
  const names = files.map((f) => f.name)
  for (const rt of RUNTIMES) {
    if (rt.detect?.(names)) return rt
  }
  // Static site: all files are static assets (or single HTML)
  const nonEnv = files.filter(
    (f) => f.name !== '.env.example' && !f.name.endsWith('.env.example'),
  )
  if (nonEnv.length > 0 && nonEnv.every((f) => isStaticFile(f.name))) {
    return NGINX_RUNTIME
  }
  // Nothing matched — default to nginx as safe fallback
  return NGINX_RUNTIME
}
