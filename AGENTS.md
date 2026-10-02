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
runs under Bun. Local development needs Node 22.22.1+ (`engines` in
`package.json`); the image builds and runs on Node 24 (`Dockerfile`).

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
pnpm run lint                 # ESLint: client/, then server/, shared/, test/ and scripts/
pnpm run lint:deep            # jscpd, knip, licenses (FOSS policy), plus lint:repo
pnpm run lint:repo            # repo rules and doc links
pnpm run lint:chart           # chart images and schemas; needs helm, and kubeconform
pnpm run typecheck            # tsc --noEmit (client/), then scripts/
pnpm run test                 # node:test for server/ and test/, then Vitest for client/
pnpm run test:coverage        # the same tests, failing below the coverage thresholds
pnpm run test:lifecycle       # chart install/upgrade/uninstall on a throwaway kind cluster
pnpm run format:check         # Prettier across the repo; CI fails on unformatted files
pnpm run build                # production client build, bundle and license checks
pnpm run start                # production server (server/server.js)
```

Run `lint`, `lint:deep`, `typecheck`, `test:coverage` and `format:check`
before you push, and `lint:chart` if you changed `chart/`. CI runs all six on
pushes to `develop` and `release/**`, plus `test:lifecycle`. PRs run them too,
except that they run `lint:repo` in place of `lint:deep` and skip
`test:lifecycle`, so a jscpd, knip or license failure, or a broken chart
lifecycle, only shows up after merge and blocks that branch's image and
chart. Husky + lint-staged run ESLint, `tsc --noEmit` and Prettier on commit.

The coverage thresholds are in `.c8rc.json` (server/ and shared/, measured
with c8 so files no test loads still count) and `client/vite.config.ts`. They
were set from the coverage the repo had at the time, rounded down. Raise them
when coverage goes up, and never lower them to get a change through. Code that
parses untrusted input (API responses, `localStorage`, URL parameters, AI
output) also gets a [fast-check](https://fast-check.dev) property test beside
its example tests, as `<name>.property.test.ts`; see
`client/src/lib/currentUser.property.test.ts`.

Functions may not exceed a cognitive complexity of 15
(`sonarjs/cognitive-complexity`); split them rather than suppressing the rule.
The functions that already did when the rule landed carry an
`eslint-disable-next-line` with their score, to split once they have tests.
`pnpm run lint:deep` also fails if more than 5% of the code is duplicated
(`.jscpd.json`), on unused files, dependencies and exports (`knip.jsonc`), and
on a production dependency whose license isn't Green under Portainer's FOSS
policy (`scripts/check-licenses.ts`). Anything else needs the FOSSCC's
approval, recorded in `third-party-licenses.json` with the reason. The build
writes the notices to `client/dist/THIRD_PARTY_NOTICES.txt`, which ships in
the image.

Commit `pnpm-lock.yaml` with any dependency change: CI and the image install
with `--frozen-lockfile`. New package versions are held back for 7 days
(`minimumReleaseAge` in `pnpm-workspace.yaml`).

## Rules

- **The add-on runs same-origin with Portainer.** Anything the client renders
  or executes runs with the user's Portainer session. The add-on security
  rules in
  [portal-template's security.md](https://github.com/portainer/portal-template/blob/develop/docs/security.md)
  apply here too.
- **User credentials never appear in server logs.** Calls made on a user's
  behalf carry that user's credential; the add-on's machine credential is
  only for reading its own settings.
- **Stored AI keys never go back to the browser.** An administrator types a
  key into Setup or Settings, and the browser sends it to Portainer's config
  store as a sensitive value. After that Portainer never returns it (the form
  shows a mask), and only the server reads it, to call the provider. Keep
  that flow; don't add a route that echoes a stored key.
- **The server speaks plain HTTP only.** TLS terminates at the add-on
  gateway. Don't add certificates or TLS listeners.
- **`ENCRYPTION_KEY` is fixed for the life of an install.** It encrypts Git
  target credentials and derives the gateway identity, so never change how it
  is derived or used without a migration path.
- **`client/design-system/` is a read-only git submodule.** Never create, edit
  or delete files inside it. Import it via `@ds/*`; `@/*` maps to
  `client/src/`.
- Never hardcode `/addons/portainer-run/`. The client build bakes the mount
  path in from `ADDON_BASE_PATH` at build time, so client code uses
  `import.meta.env.BASE_URL`. The gateway strips the prefix before forwarding,
  so server routes match root-relative paths (`/api/...`, `/mcp`).
  `pnpm run lint` rejects an `/addons/` literal in `client/src/`, and an
  external URL in a load (`fetch`, `<img src>` and the like): the gateway's
  CSP only allows same-origin loads, and `pnpm run build` checks the built
  HTML and CSS for the same.
- Branch off and open PRs into `develop` by default. A fix for a release
  line that already shipped goes into its `release/X.Y` branch instead, then
  gets cherry-picked forward to `develop`
  ([docs/releases.md](docs/releases.md)). Branch names, commit messages and PR
  titles follow
  [portal-template's git conventions](https://github.com/portainer/portal-template/blob/develop/docs/guidelines/git-conventions.md):
  `<type>(<scope>): <subject> [<linear-id>]` and
  `<type>/<linear-id>/<short-desc>`.
- **Never skip hooks** (`git commit --no-verify` is not allowed), and never
  commit secrets or credentials: a real `.env`, a `dev-values.yaml`, or
  anything under `data/`. The tracked `*.example` files are templates. Keep
  them up to date, with placeholder values only.
- Don't hand-edit versions in `chart/Chart.yaml` or `chart/values.yaml`;
  releases are driven by CI ([docs/releases.md](docs/releases.md)).

## Agent instruction files

This repo uses `AGENTS.md`, not `CLAUDE.md`. Don't add a `CLAUDE.md` anywhere,
at the root or in a subfolder; `pnpm run lint:deep` fails on one. If a folder needs its own instructions, put
them in an `AGENTS.md` in that folder.
