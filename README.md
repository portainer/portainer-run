# Portainer-Run

A self-service deployment portal for Kubernetes, backed by the Portainer API. Portainer-Run sits between people who can build applications with AI coding tools and the Kubernetes infrastructure those applications need to run on.

Full documentation — requirements, installation, usage, and architecture — is published at **[docs.portainer.ai](https://docs.portainer.ai/)**. This README covers repo-level and contributor-facing detail; treat the docs site as the source of truth for installing and operating Portainer-Run.

## Quick start

Portainer-Run installs as an add-on from within Portainer Business Edition — there is no standalone Docker or Kubernetes-manifest deployment. An administrator installs it via **Administration → Add-ons** in the Portainer UI. See [docs.portainer.ai/requirements](https://docs.portainer.ai/requirements) and [docs.portainer.ai/quick-start](https://docs.portainer.ai/quick-start) for the full prerequisites and install steps.

Once installed, see [Connecting](#connecting) below for how to reach it.

## Why this exists

AI has made everyone a developer. Not a software engineer, not a full-stack engineer... a developer. Someone who can take a business problem, describe it to an AI coding tool, and get a working application out the other side. The barrier to creation has effectively gone.

The best AI-assisted development tools know this. It is why they push hosting onto their own SaaS or PaaS: it is the only way to keep the experience seamless end to end. And it works, right up until the app needs to talk to something inside your network. An internal database. An on-prem API. A system that lives behind the firewall and is not going anywhere. At that point the experience collapses, and the only path forward is a ticket to the platform team.

That platform team is already stretched. The influx of deployment requests coming from people who have never touched infrastructure is a real and growing problem with no clean answer today. Buying an IDP that takes a year to configure before anyone can use it is not the answer.

Portainer-Run sits in that gap. The source folder an AI coding tool produces is already an artifact. Portainer-Run is the "now run it, inside your environment" layer, with the platform team's guardrails baked in via Portainer's existing RBAC and policy controls. The platform team's role shifts from processing every deployment ticket to setting the rules once.

## What it does

Portainer-Run authenticates against your Portainer instance using your Portainer session (or, for non-browser clients like MCP, an API access token). Access is governed entirely by your Portainer RBAC role. Once connected it provides a unified view across all Kubernetes environments your account can reach.

**Applications** is the primary operational view and the landing page after login. It lists all deployments tagged `managed-by=portainer-run` with a traffic light status per row, sortable by name, environment, health, or creation date. Status reasons are read from pod state and shown in plain English: "App keeps crashing (4 restarts)", "Can't download the image", "No node has enough resources", and so on. The access column shows a clickable address, and a Deployed by column shows who created each application, which is useful where a project space is shared across a team. Each row has Logs, Restart, and Delete actions. A **+ Deploy** button in the page header opens the Deploy page.

There is no separate Dashboard page. Applications serves that role.

**Deploy** is the path for source files produced by AI coding tools. Drop the files the AI tool generated, and Portainer-Run handles runtime detection, dependency installation, git commit, and Kubernetes deployment automatically. No Dockerfile, no CI pipeline, no container registry required.

The runtime is detected from the file structure. A `package.json` maps to Node.js. A `requirements.txt` maps to Python. A `Gemfile` maps to Ruby. `.php` files map to PHP with Apache. Everything else defaults to nginx for static HTML, CSS, and JavaScript.

On deploy, up to three init containers run before the app starts: the first clones source files from git into a PersistentVolume, the second runs the dependency installer (`npm install`, `pip install`, and so on) in the correct runtime image, and the third writes a `.env` file from the entered environment variables. None of this requires a build step. Every application is deployed with sane resource requests and limits: a request of 0.1 CPU and 1Gi of memory, and a limit of 1 CPU and 4Gi of memory. These values live in the committed manifest, so a platform administrator can adjust them in git if a workload needs more.

Every pod is deployed hardened to the Kubernetes baseline pod security profile. All containers, the application and every init container, drop all Linux capabilities, disallow privilege escalation, and run under the RuntimeDefault seccomp profile. The pod does not mount a service account token. `runAsNonRoot` and a read-only root filesystem are intentionally not forced, because the clone, install, and env-writing steps and many AI-generated images legitimately write to the filesystem and start as root; forcing non-root here would break the common case.

Environment variables whose names imply a secret (for example PASSWORD, SECRET, TOKEN, API_KEY, ACCESS_KEY, PRIVATE_KEY, CREDENTIALS, AUTH, DSN, CONNECTION_STRING, CERT, SIGNING) are detected automatically. Rather than being written into the committed manifest, their values are stored in a Kubernetes Secret in the target namespace and referenced by the container via `secretKeyRef`, so the sensitive value never reaches the git repository. Non-sensitive variables keep the plain behavior and are written to the committed `.env`. Detection is name-based and errs toward caution. Note that an app reading only from a `.env` file will not see secret values there; those arrive through the container environment instead.

If uploaded files include a `.env.example`, Portainer-Run detects it and presents an editable list of keys before deploying. Keys whose names look sensitive are masked in the form, and on deploy their values are routed to a Kubernetes Secret rather than committed to git, as described above.

When your Portainer account can reach only a single environment, and that environment has only a single project space (namespace), the environment and project space selectors are hidden and replaced with a one-line summary of where the app will land. This keeps the deploy flow free of infrastructure choices for users who have none to make.

Deploy also supports deploying directly from an existing git repository. Instead of uploading files, select a configured git target, branch, and optional subfolder. Portainer-Run fetches the file listing, detects the runtime, and clones directly from that source repository on every pod start.

Clicking any application opens a detail panel with tabs for Overview, Containers, Metrics, Logs, Revisions, and Edit. The Edit tab reads the committed manifest back and lets you change how the app is exposed, adjust or add environment variables, and upload a revised set of source files. Environment variable changes are written back to the manifest in git (both the container environment and the generated `.env` file), and Portainer reconciles on the next poll cycle. Sensitive variables are handled the same way as on first deploy: they are stored in a Kubernetes Secret and referenced by the manifest rather than committed in plain text.

**Cluster Readiness** (admin only) checks each environment for ingress, LoadBalancer, storage, node health, and GPU availability, and lets administrators disable environments from the deploy flow.

**Settings** (admin only) is where Portainer-Run's own configuration is managed: the encryption key, AI provider keys, base domain, and gateway URL. Values are stored in Portainer rather than in the chart, so they survive upgrades and never appear in Helm's release history. See [Setup and configuration](#setup-and-configuration).

**Assistant** is a persistent chat panel available on every page. It is context-aware and fetches live diagnostic data before answering health questions. It directs all deployment questions to the Deploy workflow and never executes irreversible operations directly.

The running release is shown at the bottom of the sidebar as "Portainer-Run [version]". The value is baked into the image at build time: tagged releases show their release version, builds from the develop branch show `develop`, pull request builds show `pr-<number>`, and local or untagged builds show `dev`.

## Git targets

Deploy commits manifests and source files to a git repository. A git target is a stored, encrypted connection to a repository. Git targets are per-user: each user's targets are only visible to themselves. Administrators can additionally mark targets as shared, making them available to all users in the deploy flow while remaining read-only for non-admins.

Manifests are committed to `<env-name>/<namespace>/<appname>.yaml` and source files to `<env-name>/<namespace>/<appname>/src/`. This structure keeps each deployment environment cleanly separated within the repository. The browser UI and the MCP endpoint use the same paths, so an app deployed either way lands in the same place.

Each target stores the provider (GitHub, GitLab, Gitea, or other), the repository in `owner/repo` form, a personal access token, an optional path prefix, and a default branch. Credentials are encrypted at rest using `ENCRYPTION_KEY`, which Portainer stores and Portainer-Run reads back at runtime (see [Setup and configuration](#setup-and-configuration)).

The Test button on each target checks connectivity and reports read and write permissions. For GitHub, the check uses the collaborator permissions API, which works correctly with fine-grained PATs. For GitHub fine-grained PATs, the token requires Contents (read and write) permission on the target repository. Classic PATs require the `repo` scope.

The target form states the minimum token scope for each provider. For GitLab this is the `api` scope: a narrower combination such as `read_api` plus `write_repository` passes GitLab's own form checks but fails when Portainer-Run writes manifests and creates the GitOps stack, so the form calls this out explicitly. This is advisory guidance rather than validation, because there is no reliable cross-provider way to introspect a token's granted scopes before use.

TLS is verified by default on requests to the git provider, since the target's token travels over that connection. When pointing a target at a self-hosted server with a self-signed certificate (custom URL for GitHub Enterprise, self-hosted GitLab, or Gitea), the target form exposes a "Skip TLS verification" toggle as an explicit per-target opt-out. This is not something Portainer-Run can fix on your behalf — prefer replacing the self-signed certificate on the git server itself with one from a trusted CA (e.g. Let's Encrypt), or, for an internal CA, redeploy Portainer-Run with `NODE_EXTRA_CA_CERTS` pointed at your CA bundle, over enabling this toggle.

For GitHub Enterprise Server, keep the provider set to GitHub and enter your server host in the GitHub server URL field. Portainer-Run uses the GitHub-compatible REST API at `/api/v3` on that host. Do not use the "Other" provider for GitHub Enterprise: that path targets the Gitea API.

For self-hosted GitLab, keep the provider set to GitLab and enter your server host in the GitLab server URL field. Leave it blank for gitlab.com.

Application removal deletes the manifest file and the source directory in a single commit. For GitHub this uses the Git Data API tree approach: one commit removes the manifest and every file under the source directory regardless of count, matching what the GitHub UI "Delete directory" button does. Removing both in one commit avoids a non-fast-forward race that could otherwise occur between two sequential commits against the same branch. The same single-commit behavior is implemented for GitLab (batch delete via the commits API) and Gitea.

## Roles

Portainer-Run derives roles from Portainer. A user with Role 1 (admin) in Portainer is an admin in Portainer-Run.

Admins see the Admin section of the navigation, which contains Cluster Readiness, Settings, and full git target management including the ability to mark targets as shared. Admins can edit and delete any git target, including shared ones. Settings is admin-only on both sides: the page refuses to render for non-admins, and Portainer's own configuration endpoints reject them.

Non-admins see their own git targets plus any shared targets created by admins. Shared targets appear with a "shared" badge and are read-only for non-admins (Test is available, Edit and Delete are not).

The logged-in Portainer username is shown in the Account section of the navigation with an "admin" badge for admin users.

## MCP endpoint

Portainer-Run exposes an MCP (Model Context Protocol) endpoint at `POST /mcp` that allows AI coding tools to deploy applications directly. When Portainer-Run runs as a Portainer addon, this endpoint is reached through the Portainer addon gateway at `https://<portainer-host>/addons/portainer-run/mcp` (the gateway authenticates the request, then strips the `/addons/portainer-run` prefix before forwarding to `/mcp`).

Authentication accepts a Portainer **API access token** via `X-API-Key: <token>` (recommended for MCP clients — these tokens are long-lived, unlike browser session JWTs), the browser session JWT via the `portainer_api_key` cookie (the addon-gateway path), or `Authorization: Bearer <jwt>`. Portainer-Run validates the credential against the same Portainer instance, routing it by type to match Portainer's own auth: tokens with the `ptr_` prefix go via `X-API-Key`, JWTs via the session cookie. The result is validated against Portainer's `/users/me` endpoint on first use and cached for five minutes.

The server returns workflow guidance in the MCP `initialize` response (`instructions`). Compliant clients surface this to the model automatically, so it knows to gather the required deployment details (environment, namespace, git target, exposure, ingress host, port behavior) and confirm them before deploying, without the user having to prompt for it.

Available tools:

`list_environments` returns Kubernetes environments accessible with the provided token, excluding any an admin has disabled from the deploy flow (Cluster Readiness).

`list_namespaces` returns namespaces in a given environment, filtered to exclude system namespaces.

`list_git_targets` returns the git targets accessible to the caller (own targets plus shared targets). When none exist it also returns a message explaining that a git target is required and must be created in the Portainer-Run UI (git targets cannot be created via MCP).

`list_ingress_classes` returns the IngressClasses defined in an environment (including which one is the cluster default), plus `baseDomain` and `ingressHostRequired`. Use it to pick an ingress class when deploying with `exposeType: "Ingress"`. When `ingressHostRequired` is `true` no base domain is configured, so a full `ingress.host` must be supplied.

`deploy_app` deploys source files to Kubernetes via the full deploy pipeline. It accepts `appName`, `envId`, `namespace`, `gitTargetId`, `files` (array of `{ path, content }`), and optional `envVars`, `exposeType`, `ingress` (`{ host, path, ingressClass }`), `runtime`, and `branch`. Runtime is auto-detected from the file structure by default; pass `runtime` (`node`, `python`, `php`, `ruby`, or `nginx`) to override, for example `nginx` to serve a static site. It parses `.env.example` for environment variables when `envVars` is not supplied. It returns a `url` for reaching the app: immediately for Ingress, and after a short poll for NodePort or LoadBalancer (null while the address is still being assigned, in which case `get_app_status` returns it once ready). When `exposeType` is `Ingress`, the host defaults to `<appName>.<BASE_DOMAIN>` if `BASE_DOMAIN` is set, and `ingressClass` defaults to the cluster's default IngressClass when not supplied.

`get_app_status` returns the running status of a deployed application from the server-side cache, plus a live access `url` resolved from the Service or Ingress.

To connect Claude Desktop, add the following to `claude_desktop_config.json` (requires Node.js for `mcp-remote`). Use a Portainer API access token (Account → Access Tokens) so the connection does not expire with a browser session:

```json
{
  "mcpServers": {
    "portainer-run": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://<portainer-host>/addons/portainer-run/mcp",
        "--header",
        "X-API-Key: YOUR_PORTAINER_API_TOKEN"
      ],
      "env": {
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

The `NODE_TLS_REJECT_UNAUTHORIZED: "0"` line is only needed when Portainer serves a self-signed or internal-CA certificate — it lets `mcp-remote` complete the TLS handshake. It disables certificate verification for the `mcp-remote` process, so use it only against trusted internal hosts and drop it once a publicly-trusted certificate is in place.

Config file location: `%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.

To verify the endpoint is working before connecting a client:

```bash
curl -k -X POST https://<portainer-host>/addons/portainer-run/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_PORTAINER_API_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Performance

The server exposes a `/env-status/:envId` endpoint that fans out to Kubernetes in parallel for a single environment (pods, services, ingresses, and nodes in one batch) then aggregates results into a per-deployment status map cached for 20 seconds. The browser fires one request per environment with a client-side concurrency limit of 5. A resourceVersion fingerprint means unchanged environments return cached results immediately.

## Architecture

```
Browser → TLS-terminating proxy → Node HTTP server (server.js) → Portainer API
                                                               → Anthropic API  (if configured)
                                                               → OpenAI API     (if configured)
```

Portainer-Run is a React and Vite frontend served by a Node HTTP server. The server forwards Kubernetes API calls to Portainer (bypassing browser CORS), relays AI requests to the configured provider (keeping the API key server-side), serves the aggregated `/env-status/` endpoint, exposes the `/mcp` MCP endpoint, and maintains a file-backed session cache.

Its own configuration comes from the same Portainer API: the server fetches it and holds it in memory, so settings are neither baked into the image nor stored in the cluster. Calls made on a user's behalf carry that user's credential. Reading its own settings uses the credential Portainer issues the add-on — a token mounted as a Secret in its namespace, good for that one API and nothing else.

User credentials never appear in server logs. AI API keys never reach the browser.

### TLS

The server speaks plain HTTP only, on port `8080` by default. It never terminates TLS and holds no certificates or private keys.

HTTPS is the responsibility of whatever sits in front of it — the Portainer addon gateway, which terminates TLS and proxies plain HTTP to this container.

The default port is deliberately unprivileged so the container can run as a non-root user.

### Session cache and data persistence

The server maintains a SQLite database at `data/portainer-run.db` for git target storage and a file-backed cache at `data/cache.json` for deployment state. Both live under `/app/data` inside the container, which the addon system persists across restarts.

`ENCRYPTION_KEY` must stay the same for the life of the installation. Git target credentials are encrypted with it at rest and the file-gateway identity is derived from it, so a changed key orphans both. Portainer holds the authoritative copy in its own database, which is why it survives pod restarts, upgrades, and the PVC being recreated. Portainer-Run fingerprints the key against the database it protects, so a key that changes or disappears is reported at boot and on the Settings page rather than letting targets quietly appear gone.

## Setup and configuration

Portainer-Run's configuration lives in Portainer, not in the chart and not in Kubernetes. Portainer holds the values; Portainer-Run fetches them over Portainer's API and keeps them in memory. No setting is written into the cluster, so there is no Secret to manage, no Helm value to set, and no redeploy when a setting changes.

`ENCRYPTION_KEY` is the clearest example. It is generated inside Portainer-Run during first-run setup, saved to Portainer's database, and read back from there whenever Portainer-Run needs it. An operator never generates it, never copies it into a values file, and never has to keep it identical across upgrades by hand.

Two consequences follow from settings being memory-only:

- **A restart refetches at boot.** Portainer issues Portainer-Run a credential of its own, mounted as a Secret in its namespace, and the server uses it to fetch settings at startup with no user behind the request.
- **Settings never enter Helm.** Helm keeps every retained revision's values in cleartext inside its own `sh.helm.release.*` Secrets, so a key passed as a chart value would linger in release history long after it was rotated. Keeping configuration out of Helm avoids that entirely.

### First-run setup

A fresh install starts with no `ENCRYPTION_KEY` and boots into an **awaiting setup** state: the UI shows the setup screen, and Git targets and deploys return `503` until configuration arrives. The server deliberately does not exit — `/config` is the liveness and readiness probe, so exiting would crashloop the pod before an administrator could ever reach the setup screen.

An administrator opens Portainer-Run and completes setup:

1. The setup screen generates an `ENCRYPTION_KEY` in the browser using the Web Crypto CSPRNG.
2. It saves the value to Portainer over the administrator's own session, never through Portainer-Run: adopting a key is a deliberate act, and Portainer records who made it.
3. It asks Portainer-Run to load its settings, which it does with its own credential.
4. Portainer-Run is configured. No restart, no redeploy.

The key is only needed _after_ setup, for encrypting Git target credentials and deriving the gateway identity, so generating it before Portainer-Run holds it presents no ordering problem.

Administrators change the AI keys, base domain, and gateway URL later from **Settings**, which uses the same save-then-load flow and takes effect immediately.

### Standalone installs

Outside the addon there is no Portainer store to read from, so environment variables seed the values instead. Anything present in the container's environment at startup is used, and Portainer's copy overrides it if a fetch later succeeds. Supply them however you normally would — a Secret consumed via `envFrom`, chart values, or an `.env` file for local development:

```bash
kubectl -n <namespace> create secret generic portainer-run-secret \
  --from-literal=ENCRYPTION_KEY=$(openssl rand -hex 32)
```

The Deployment reads a Secret of that name as an _optional_ `envFrom` source, so it is picked up if present and ignored if absent.

### Existing installations

An installation whose `ENCRYPTION_KEY` was set by hand keeps working unchanged, because environment variables still seed the configuration.

To move it under Portainer's management, the setup screen detects the case and offers to import the current key rather than replace it. The key never reaches the browser: the import runs server-side, sending the value Portainer-Run already holds to Portainer over the administrator's forwarded session. Import before removing the environment variable, so the value is banked before its only source disappears.

If the key is lost anyway, Portainer-Run fails loudly rather than silently. It fingerprints the key against the database that key protects, so:

- A **changed** key is reported at boot and on the Settings page, with the number of Git targets that can no longer be read.
- A **missing** key with encrypted data still present is reported as a dropped key, never as a fresh install, and the setup screen refuses to generate a replacement that would orphan the existing credentials.

Restoring the original value recovers everything with no further action.

## Local development

The repo uses [Bun](https://bun.sh) for installs, scripts, and the Vite build.

```bash
bun install
bun run dev
```

The container image builds and runs on Node instead (see the `Dockerfile`), so the
server code stays free of Bun-specific APIs — SQLite comes from `node:sqlite`. Node 22.5
or newer is required to run `server/server.js` directly.

## Environment variables

When installed as a Portainer add-on you do not set these by hand. Portainer stores the configuration and Portainer-Run reads it back at runtime; the encryption key and AI keys are managed from [first-run setup and the Settings page](#setup-and-configuration), and the image repository/tag and storage class from the Add-ons setup screen. See [docs.portainer.ai/quick-start](https://docs.portainer.ai/quick-start).

The variables below are read only at startup, to seed the initial configuration. A value fetched from Portainer takes precedence over the matching variable. They remain the way to configure a standalone install or local development, and the table documents what each one does at the container level.

`PORTAINER_URL` is required and is genuine bootstrap: Portainer-Run cannot reach Portainer without it, so it can never come from Portainer. `ENCRYPTION_KEY` is required before Git targets and deploys work, but the server starts without it and waits for setup. All others are optional.

| Variable            | Default          | Description                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORTAINER_URL`     | (required)       | Full URL of your Portainer instance. Example: `https://portainer.example.com:9443`                                                                                                                                                                                                                                                                                                                        |
| `ENCRYPTION_KEY`    | (from Portainer) | Encrypts stored git target credentials at rest and derives the gateway identity. At least 32 characters, and fixed for the life of the installation. Generated during first-run setup and stored in Portainer's database; set it manually only for standalone installs.                                                                                                                                   |
| `ANTHROPIC_API_KEY` | (none)           | Anthropic API key. Enables the Assistant using Claude.                                                                                                                                                                                                                                                                                                                                                    |
| `OPENAI_API_KEY`    | (none)           | OpenAI API key. Enables the Assistant using GPT-4o. Set one or the other, not both. Anthropic takes priority if both are set.                                                                                                                                                                                                                                                                             |
| `AI_PROVIDER`       | auto             | Override AI provider: `anthropic` or `openai`. Auto-detected from whichever key is set.                                                                                                                                                                                                                                                                                                                   |
| `OPENAI_MODEL`      | `gpt-4o`         | OpenAI model override.                                                                                                                                                                                                                                                                                                                                                                                    |
| `BASE_DOMAIN`       | (none)           | Base domain for Ingress exposure. If set, the deploy flow defaults the Ingress host to `appname.BASE_DOMAIN`.                                                                                                                                                                                                                                                                                             |
| `GATEWAY_URL`       | (none)           | File relay that every MCP deploy stages its source through — there is no inline transfer path, so MCP deploys are disabled until it is set. Portainer hosts one at `https://run-gateway.portainer.ai`; app source transits it, so egress-restricted or air-gapped installs should host their own. A bare hostname is assumed `https`. Does not affect browser uploads, which go straight to the instance. |
| `PORT`              | `8080`           | Plain-HTTP listen port inside the container. TLS terminates at the proxy in front of it.                                                                                                                                                                                                                                                                                                                  |

`PORTAINER_RUN_VERSION` is not a runtime setting. It is a Docker build argument, set by the CI and release workflows at image build time, and surfaced read-only in the sidebar. Local builds default it to `dev`.

## Connecting

Portainer-Run runs as a Portainer addon. Reach it at `https://<portainer-host>/addons/portainer-run/` after logging in to Portainer; the addon gateway authenticates the request against your Portainer session, so there is no separate token entry. Unauthenticated requests are handed off to the Portainer login page. Your Portainer RBAC role determines what Portainer-Run can see and do: namespace-scoped access requires manual namespace entry on deploy; cluster-scoped access enumerates namespaces automatically.

Portainer's RBAC applies in full. Users with admin role in Portainer see the Admin section including Cluster Readiness and shared git target management. Non-admin users see only their own targets plus any shared targets an admin has created.

The browser session lasts as long as the Portainer session cookie; logging out clears it. Non-browser clients such as the MCP endpoint authenticate with a Portainer API access token instead (see [MCP endpoint](#mcp-endpoint)).

## Notes on scope

Portainer-Run only surfaces deployments it created. It tags every Deployment, Service, PVC, and Ingress with `managed-by=portainer-run` and filters the Applications page to that label. Workloads deployed through Portainer's own UI or `kubectl` will not appear.

Persistent storage volumes cannot be modified after deployment. PVCs are created at deploy time and are not touched by the Edit tab.

OAuth authentication is not supported. Users in OAuth-configured Portainer deployments should generate a personal access token in Portainer under Account, then Access Tokens.
