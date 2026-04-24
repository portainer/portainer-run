import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const self = process.execPath

/** @param {import('node:child_process').ChildProcess} child */
function safeKill(child) {
  if (!child.pid) return
  try {
    if (isWin) child.kill()
    else child.kill('SIGTERM')
  } catch {
    // ignore
  }
}

const serverEnv = {
  ...process.env,
  PORT: process.env.PORT || '8443',
  HTTP_PORT: process.env.HTTP_PORT || '0',
}
const port = serverEnv.PORT
const devApi = `https://127.0.0.1:${port}`

const server = spawn(
  self,
  [path.join(root, 'server', 'server.js')],
  {
    cwd: root,
    env: serverEnv,
    stdio: 'inherit',
  }
)

const client = spawn('bun', ['run', 'dev'], {
  cwd: path.join(root, 'client'),
  env: { ...process.env, DEV_API_ORIGIN: devApi },
  stdio: 'inherit',
  shell: false,
})

function shutdown() {
  safeKill(client)
  safeKill(server)
  setTimeout(() => process.exit(0), 200)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

let exiting = false
function finish(code) {
  if (exiting) return
  exiting = true
  if (code !== 0) safeKill(client)
  if (code !== 0) safeKill(server)
  process.exit(typeof code === 'number' ? code : 0)
}

server.on('error', (err) => {
  console.error('[dev] server spawn failed:', err.message)
  finish(1)
})
client.on('error', (err) => {
  console.error('[dev] client spawn failed:', err.message)
  finish(1)
})
server.on('close', (code) => {
  if (!exiting) {
    safeKill(client)
    finish(code ?? 0)
  }
})
client.on('close', (code) => {
  if (!exiting) {
    safeKill(server)
    finish(code ?? 0)
  }
})

console.log(
  `Dev: API https://127.0.0.1:${port}  ·  UI http://127.0.0.1:5173  (Vite → API proxy uses DEV_API_ORIGIN)\n`
)
