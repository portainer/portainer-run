# Releases

How to cut a release of this addon.

> Releases are cut and published entirely through GitHub Actions — no local
> build or publish commands or manual file edits.

**Registries** (already the convention in this repo):

- `portainerci/portainer-run` — CI and pre-release images. Auto-built by
  [`ci.yml`](../.github/workflows/ci.yml) on pushes to `develop` and
  `release/**` branches; also what a pre-release dispatch publishes. Don't
  reference this in production.
- `portainer/portainer-run` — public **release** images that users pull. No
  `:latest` is ever published here — that's deliberate, not a gap; always
  reference an exact version.
- `oci://ghcr.io/portainer/dev-charts` — dev/pre-release chart snapshots,
  published continuously by `ci.yml` and by a pre-release dispatch.
- `oci://ghcr.io/portainer/charts` — the real chart registry. One chart
  version per release, matching the release tag exactly.

## Before your first release (one-time)

CI already publishes `develop` images and dev chart snapshots for you. Before
the first _release_, make sure these are set up:

- [ ] `chart/Chart.yaml` → `name:` is `portainer-run`
- [ ] `chart/values.yaml` → `image.repository` and `addonBasePath` are set
- [ ] You have push access to `portainer/portainer-run` (Docker Hub) and
      `ghcr.io/portainer/charts`
- [ ] `DOCKER_HUB_USERNAME` / `DOCKER_HUB_PASSWORD` / `PORTAINER_BOT_ID` /
      `PORTAINER_BOT_KEY` repo secrets are set — both
      [`release.yml`](../.github/workflows/release.yml) and
      [`ci.yml`](../.github/workflows/ci.yml) need them
- [ ] If you want Dependabot to actually open PRs bumping the SHA-pinned
      `portainer/github-actions` refs below, its own repo secrets need
      setting separately — the ordinary Actions secrets above aren't visible
      to Dependabot

## Cutting a release

This is a **GA** add-on, so `release.yml` must be dispatched from a
`release/X.Y` branch — `resolve-image-tag` fast-fails otherwise (unlike the
beta add-ons, which opt out via `enforce-release-branch: false`).

**First release in a line:**

```bash
git checkout develop
git pull
git checkout -b release/1.4
git push --set-upstream origin release/1.4
```

Then: **Actions → release → Run workflow** → set **Use workflow from** to
`release/1.4`, enter the version (e.g. `1.4.0`), and choose:

- **Pre-release** (the default) — a full dry run. Builds, scans, and
  publishes the image to `portainerci/portainer-run:<version>` and a dev
  chart snapshot. No GitHub Release is created. Safe to re-run with the same
  version as many times as you like.
- **Real release** (uncheck pre-release) — publishes the image to
  `portainer/portainer-run:<version>`, the real chart to
  `oci://ghcr.io/portainer/charts`, and creates the GitHub Release, marked
  latest — all in this one dispatch. There is no separate promotion step,
  and the release isn't created unless the image actually exists.

> `chart/Chart.yaml` and `chart/values.yaml` are never hand-edited or
> committed per release — the values checked into the repo are placeholders,
> always overridden at publish time.

**A patch to an existing line:** PR the fix into `release/1.4` directly, then
run **release** again from that branch with the next patch version (e.g.
`1.4.1`). Afterwards, cherry-pick the same commit(s) forward to `develop` —
that's the one manual step this model adds, and skipping it means the fix
regresses at the next minor release.

## Register the add-on (first release only)

A published chart is installable but invisible until Portainer knows about it. After your
**first** release, register the add-on so it shows up in the catalog with an icon.
Subsequent releases need no re-registration; the catalog tracks the chart repository,
not the version.

> This repo doesn't have its own `docs/registering.md` yet (unlike
> `portal-template`/`portainer-command`/`portainer-migrate`, which each carry a
> copy of the registration walkthrough) — follow the process documented in one
> of those repos until this one gets its own copy.

---

`ci.yml` and `release.yml` consume [`portainer/github-actions`](https://github.com/portainer/github-actions)'s
shared, SHA-pinned workflows — the actual build/scan/publish logic lives
there, not in this repo. See that repo's own README for the full design.

> The first chart push creates a **private** GHCR package by default — a
> GitHub org owner needs to flip `ghcr.io/portainer/charts/portainer-run`
> to public (package **Settings** → **Change visibility**) before anyone
> else can pull it. Only needed once, after the first release.
