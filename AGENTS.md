# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should
start at [README.md](README.md); everything here is also true for them.

## What this is

Portainer-Run is a Portainer add-on: a self-service deployment portal for
Kubernetes, backed by the Portainer API. It's a React + Vite frontend
(`client/`) served by a plain Node HTTP server (`server/`), behind Portainer's
add-on gateway at `/addons/portainer-run/`. The server proxies Kubernetes
calls to Portainer, relays AI requests to the configured provider so the key
stays server-side, serves `/env-status/` and the `/mcp` endpoint, and keeps
Git targets in SQLite (`node:sqlite`) under `data/`.

Runtime is **Node + pnpm**. Use `pnpm`, never `npm` or `yarn`. Nothing here
runs under Bun.

Layout:

- `client/`: the SPA. `client/design-system/` is the design-system submodule.
- `server/`: the backend, plain ES-module JavaScript. `server.js` is the
  entry point, `handler.js` routes requests, and `routes/`, `proxy/`, `lib/`
  and `db/` hold the rest. Tests sit next to each module as `*.test.js` and
  run on `node:test`.
- `shared/`: code imported by both `client/` and `server/`.
- `test/`: repo-level tests (chart, shared runtimes).
- `chart/`: the Helm chart Portainer installs.

The root, `client/` and `server/` are one pnpm workspace with a single
`pnpm-lock.yaml`.

## Commands

```bash
git submodule update --init   # client/design-system; required before build or typecheck
pnpm install
pnpm run dev                  # Vite dev server (client/)
pnpm run lint                 # ESLint (client/)
pnpm run typecheck            # tsc --noEmit (client/)
pnpm run test                 # node:test for server/ and test/, then Vitest for client/
pnpm run format:check         # Prettier across the repo; CI fails on unformatted files
pnpm run build                # production client build
pnpm run start                # production server (server/server.js)
```

Run `lint`, `typecheck`, `test` and `format:check` before you push. CI runs the
same. Husky + lint-staged run ESLint, `tsc --noEmit` and Prettier on commit.

Commit `pnpm-lock.yaml` with any dependency change: CI and the image install
with `--frozen-lockfile`. New package versions are held back for 7 days
(`minimumReleaseAge` in `pnpm-workspace.yaml`).

## Rules

- **The add-on runs same-origin with Portainer.** Anything the client renders
  or executes runs with the user's Portainer session. The add-on security
  rules in
  [portal-template's security.md](https://github.com/portainer/portal-template/blob/develop/docs/security.md)
  apply here too.
- **User credentials never appear in server logs, and AI API keys never reach
  the browser.** Calls made on a user's behalf carry that user's credential;
  the add-on's machine credential is only for reading its own settings.
- **The server speaks plain HTTP only.** TLS terminates at the add-on
  gateway. Don't add certificates or TLS listeners.
- **`ENCRYPTION_KEY` is fixed for the life of an install.** It encrypts Git
  target credentials and derives the gateway identity, so never change how it
  is derived or used without a migration path.
- **`client/design-system/` is a read-only git submodule.** Never create, edit
  or delete files inside it. Import it via `@ds/*`; `@/*` maps to
  `client/src/`.
- Never hardcode `/addons/portainer-run/` in client code; use
  `import.meta.env.BASE_URL`.
- Branch off and open PRs into `develop`. Branch names, commit messages and PR
  titles follow
  [portal-template's git conventions](https://github.com/portainer/portal-template/blob/develop/docs/guidelines/git-conventions.md):
  `<type>(<scope>): <subject> [<linear-id>]` and
  `<type>/<linear-id>/<short-desc>`.
- **Never skip hooks** (`git commit --no-verify` is not allowed), and never
  commit secrets, `.env*` files, or anything under `data/`.
- Don't hand-edit versions in `chart/Chart.yaml` or `chart/values.yaml`;
  releases are driven by CI ([docs/releases.md](docs/releases.md)).

## Agent instruction files

This repo uses `AGENTS.md`, not `CLAUDE.md`. Don't add a `CLAUDE.md` anywhere,
at the root or in a subfolder. If a folder needs its own instructions, put
them in an `AGENTS.md` in that folder.
