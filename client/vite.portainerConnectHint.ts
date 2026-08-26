import type { Plugin } from 'vite'

// On `pnpm run dev`, print the commands that wire this add-on into a locally-run
// Portainer, derived from its own base path and dev port so a fresh clone prints a
// correct command. See docs/developing-inside-portainer.md in the portal-template
// repo.
export function portainerConnectHint(base: string, port: number): Plugin {
  const basePath = base.replace(/\/+$/, '') // /addons/<id> — no trailing slash
  return {
    name: 'portainer-connect-hint',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        server.config.logger.info(
          [
            '',
            '  ▸ Connect this add-on to a locally-run Portainer',
            '    (run in your portainer-suite checkout):',
            '',
            `      DEV_ADDONS=${basePath}=http://localhost:${port} \\`,
            '        make -C package/server-ee dev-server-mirrord',
            '',
            '    leave the existing dev-client terminal running, then open',
            '    http://localhost:8999 and pick it from the app switcher',
            '    (install it once from the Addons screen to get it listed).',
            '',
          ].join('\n'),
        )
      })
    },
  }
}
