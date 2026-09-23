# GitHub project setup

The **first stage** of an add-on's lifecycle: getting the repository onto
Portainer's security and workflow standards before any add-on code is written.

**Audience:** anyone starting a new add-on repo, and anyone who wants to
understand why `portainer-run`'s CI/release setup is built the way it is.

## Start here: request the repo via Linear

Raise a **"Portainer add-on repository setup"** issue in Linear (PLA team).
Don't configure any of this by hand — Platform actions the request and sets up:

- **DockerHub** — repo created in both `portainerci` (CI images, machine-account
  write access) and `portainer` (release images) orgs; Docker Scout enabled
  for each.
- **Secrets** — `DOCKER_HUB_USERNAME`, `DOCKER_HUB_PASSWORD` (DockerHub write
  access), `PORTAINER_BOT_ID`, `PORTAINER_BOT_KEY` (design-system repo access).
- **GitHub settings** — default branch `develop`; Wikis, Issues, Discussions,
  and Projects disabled; squash-merge only with PR title as the commit
  message; auto-delete head branches after merge.
- **Access** — no repo-specific action needed. `portainer/engineering` has
  org-inherited write access to all repos; `portainer/product` has
  org-inherited read access by default. If different access is needed, raise
  it in the repository-setup Linear request.

### Not yet covered by the template — raise separately if needed

- [ ] Secret rotation ownership/cadence for the bot key and DockerHub
      credentials.
- [ ] **Dependabot alerts + security updates** (Settings → Code security) —
      has a per-active-committer cost on private/internal repos, not an org
      default. Enable only with explicit sign-off, separately from the
      standard setup above.
- [ ] `docs/registering.md` — this repo doesn't have one yet, unlike its
      siblings. See [releases.md](releases.md)'s "Register the add-on"
      section.
- [ ] The pre-existing `DOCKER_USERNAME`/`DOCKER_PASSWORD` secrets (this
      repo's original naming, now superseded by `DOCKER_HUB_USERNAME`/
      `DOCKER_HUB_PASSWORD` as of this migration, to match every other
      add-on repo) can be removed once nothing references them.

## What you get, and why (reference — no action needed)

`ci.yml` and `release.yml` are the working reference. Nothing below needs
action from you; it's here so the non-obvious _choices_ make sense if you're
ever reading or extending these workflows.

- **Free secret scanning** — runs the OSS gitleaks CLI directly (pinned by
  SHA256), not `gitleaks-action`, which needs a paid GitHub Advanced Security
  per-developer license on org-owned private repos.
- **Vulnerability scanning is new as of this migration** —
  [Docker Scout](https://docs.docker.com/scout/) didn't scan anything in this
  repo before. Now scans the image each build just pushed (no separate
  rebuild). **Non-blocking on every path** (CI, pre-release, and a real
  release) — a deliberate choice for the first migration pass despite this
  being a GA add-on, since there's no track record yet of what a clean scan
  looks like here. Revisit tightening to blocking once there is one. Uses
  the org's existing Scout entitlement on the DockerHub repo.
- **Chart-render-guard exists in the shared repo, but is NOT enabled here** —
  `validate` has an opt-in `enforce-no-secrets-guard` input that this repo's
  chart doesn't qualify for: it legitimately renders a Secret (a generated
  `ENCRYPTION_KEY`, carried across `helm upgrade`) — this repo is one of the
  two the shared `chart-render-guard` composite action's own description
  names as the reason the guard defaults off. Confirmed by actually
  rendering the chart before wiring this up.
- **Supply-chain provenance** — image builds emit an SBOM and provenance
  (`sbom: true`, `provenance: mode=max`).
- **Short-lived GitHub App tokens** — CI exchanges the org App credentials for
  a ~1h, read-only installation token to reach the private `design-system`
  submodule. No SSH keys, deploy keys, or long-lived PATs.
- **SHA-pinned actions** — every third-party action is pinned to a full
  commit SHA with a `# vX.Y.Z` comment. Dependabot (`.github/dependabot.yml`)
  bumps them for you. Prefer GitHub-verified / official actions.
- **Conventional Commit PR titles** — enforced in CI
  (`.github/workflows/pr-title.yml`, new as of this migration — this repo
  had no PR-title convention check before). We squash-merge, so the PR title
  becomes the commit subject on `develop`.
- **`develop` as the trunk**, squash-and-merge.
- **One release action, two outcomes** — `release.yml` (manual
  `workflow_dispatch`, must run from a `release/X.Y` branch) validates,
  builds, scans, and publishes the image in a single dispatch. A
  `pre-release` boolean (default true) picks the outcome: pre-release
  publishes to `portainerci` and a dev chart, no GitHub Release; a real
  release publishes to `portainer`, the real chart, and creates the GitHub
  Release marked latest — only once the image actually exists. There is no
  separate promotion step — see [releases.md](releases.md).
- **Direct image publishing, no fork-safe split** — CI builds and pushes the
  image directly in one job; there's no build-then-publish split that
  withholds secrets from PR builds. This repo is genuinely **public**,
  unlike its siblings, but takes no external PRs in practice (confirmed:
  every recent PR came from within the org) — that split existed before this
  migration and is deliberately dropped here, not preserved. If this repo
  ever starts taking external PRs for real, reintroduce it.
- **Two-package pnpm workspace** — `client/` (Vite/React) and `server/`
  (Node), one root `pnpm-lock.yaml`. Root `test` runs both: server tests via
  Node's built-in test runner, then `pnpm --filter portainer-run-ui test`
  (client's vitest suite) — folded into one script as part of this migration
  so the shared `validate.yml`'s single `test` job step still covers both,
  same coverage CI had as two separate steps before.
- **`PORTAINER_RUN_VERSION` is now release-only** — `release.yml`'s
  `normalize-version` job feeds the real version into the image's
  `PORTAINER_RUN_VERSION` build-arg; `ci.yml` never sets it. This is a
  visible change from before: CI/PR builds used to stamp the real
  `pr-<n>`/branch tag in, now they fall back to the app's own `'dev'`
  default. Confirmed cosmetic-only (a footer string), never load-bearing,
  before accepting that tradeoff. A follow-up would be needed to align with
  how other add-ons pick up their version string, if that's wanted here too.

## Developer notes

Small, ongoing things — not repo setup, just FYI once you're working in it:

- Configure local commit signing — the ruleset requires signed commits.
- Branch names should match what `pr-title.yml` expects: `feat/`, `fix/`,
  `docs/`, `refactor/`, `perf/`, `test/`, `build/`, `ci/`, `chore/`.

## Decisions on record

- **Release branch strategy:** this is a **GA** add-on — `release.yml` uses
  the shared workflow's default (`enforce-release-branch` left unset, so it
  stays `true`), so every release/pre-release dispatch must come from a
  `release/X.Y` branch. See `portainer-migrate`/`portainer-command`/
  `portainer-idp` for the beta opt-out shape instead.
- **Scout blocking policy:** `non-blocking: true` on `scout-app-image` in
  both `ci.yml` and `release.yml` (all paths) — see "What you get, and why"
  above for why this GA repo still opts out for now.
- **Public vs private:** the repo is genuinely **public** — but CI is not
  fork-safe (see "Direct image publishing" above), a deliberate choice since
  this repo takes no external PRs today. If that changes, reintroduce the
  fork-safe split.
