# Portainer Run

A self-service deployment portal for Kubernetes, backed by the Portainer API. Portainer Run sits between people who can build applications with AI coding tools and the Kubernetes infrastructure those applications need to run on.

## Quick start

Deploy Portainer Run then access it via `https://your-ip-address/`.

### Kubernetes

Refer to [deploy/kubernetes.yaml](deploy/kubernetes.yaml).

### Docker Run

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v portainer-run-data:/app/data \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e ANTHROPIC_API_KEY=your-anthropic-api-key-here \
  --name portainer-run \
  portainer/portainer-run:latest
```

### Docker Compose

Refer to [deploy/docker-compose.yml](deploy/docker-compose.yml).

## Why this exists

AI has made everyone a developer. Not a software engineer, not a full-stack engineer... a developer. Someone who can take a business problem, describe it to an AI coding tool, and get a working application out the other side. The barrier to creation has effectively gone.

The best AI-assisted development tools know this. It's why they push hosting onto their own SaaS or PaaS; it's the only way to keep the experience seamless end to end. And it works, right up until the app needs to talk to something inside your network. An internal database. An on-prem API. A system that lives behind the firewall and isn't going anywhere. At that point the experience collapses, and the only path forward is a ticket to the platform team.

That platform team is already stretched. The influx of deployment requests coming from people who have never touched infrastructure is a real and growing problem with no clean answer today. Buying an IDP that takes a year to configure before anyone can use it is not the answer.

Portainer Run sits in that gap. The container image (or source folder) is already an artifact AI coding tools can produce. Portainer Run is the "now run it, inside your environment" layer, with the platform team's guardrails baked in via Portainer's existing RBAC and policy controls. The platform team's role shifts from processing every deployment ticket to setting the rules once.

## What it does

Portainer Run connects to your Portainer instance using a personal access token. Access is governed entirely by your Portainer RBAC role. Once connected it provides a unified view across all Kubernetes environments your account can reach.

**Applications** is the primary operational view and the landing page after login. It lists all deployments tagged `managed-by=portainer-run` with a traffic light status per row, sortable by name, environment, health, or creation date. Status reasons are fetched from pod state and shown in plain English: "App keeps crashing (4 restarts)", "Can't download the image", "No node has enough resources", and so on. The exposure column shows a clickable address. Each row has Logs, Restart, and Delete actions. A **+ Deploy** button in the page header adapts to enabled features: if only one deploy feature is enabled it navigates directly; if multiple are enabled it shows a dropdown listing the available options.

There is no separate Dashboard page. Applications serves that role.



**Vibe Deploy** is the deployment path designed for source files produced by AI coding tools. Drop the files Claude or another AI tool generated, and Portainer Run handles runtime detection, dependency installation, git commit, and Kubernetes deployment automatically. No Dockerfile, no CI pipeline, no container registry required.

The runtime is detected from the file structure. A `package.json` maps to Node.js 20. A `requirements.txt` maps to Python 3.12. A `Gemfile` maps to Ruby 3.3. `.php` files map to PHP 8.3 with Apache. Everything else defaults to nginx for static HTML/CSS/JS.

On deploy, three init containers run before the app starts: the first clones source files from git into a PersistentVolume, the second runs the dependency installer (`npm install`, `pip install`, etc.) in the correct runtime image, and the third writes a `.env` file from the entered environment variables. None of this requires a build step.

If uploaded files include a `.env.example`, Portainer Run detects it and presents an editable list of keys before deploying. Keys matching common patterns (SECRET, TOKEN, KEY, PASSWORD) are masked in the form.

Vibe Deploy also supports deploying directly from an existing git repository. Instead of uploading files, select a configured git target, branch, and optional subfolder — Portainer Run fetches the file listing, detects the runtime, and clones directly from that source repository on every pod start.

**Simple Deploy** provides a Cloud Run-style form for single-container and multi-container (sidecar) workloads, supporting persistent storage, environment variables, Kubernetes Secret references, resource limits including GPU, and all service exposure types.

**Manifest Builder** provides a guided form for any Kubernetes workload type: Deployments, StatefulSets, DaemonSets, CronJobs, Services, Ingresses, and HPAs. All output is committed to git as a GitOps stack managed by Portainer.

**Catalogue** provides one-click deployment of pre-configured application stacks from a JSON template library. Each template can be deployed immediately with defaults, or customized in the Deploy form first.

**Secrets** provides a namespace-scoped view of Kubernetes Secrets with create and delete operations.

Clicking any service opens a detail panel with tabs for Overview, Containers, Metrics, Logs, Revisions, and Edit.

**Cluster Readiness** (admin only) checks each environment for ingress, LoadBalancer, storage, node health, and GPU availability, and allows administrators to disable environments from all deployment flows.

**Assistant** is a persistent chat panel available on every page. It is context-aware, fetches live diagnostic data before answering health questions, can translate a Docker Compose file into a deployment configuration, and routes to the appropriate deploy flow. It never executes irreversible operations directly. When Vibe Deploy is the only enabled deploy feature, the assistant redirects all deployment questions to the Vibe Deploy workflow.

## Git targets

All deploy paths commit manifests and source files to a git repository. A git target is a stored, encrypted connection to a repository. Git targets are per-user: each user's targets are only visible to themselves. Administrators can additionally mark targets as shared, making them available to all users in deploy flows while remaining read-only for non-admins.

Manifests are committed to `<env-name>/<namespace>/<appname>.yaml` and source files to `<env-name>/<namespace>/<appname>/src/`. This structure keeps each deployment environment cleanly separated within the repository.

Each target stores the provider (GitHub, GitLab, Gitea, or other), the repository in `owner/repo` form, a personal access token, an optional path prefix, and a default branch. Credentials are encrypted at rest using `ENCRYPTION_KEY`. This key must remain identical across deploys or stored targets become unreadable.

The Test button on each target checks connectivity and reports read and write permissions. For GitHub, the check uses the collaborator permissions API, which works correctly with fine-grained PATs. For GitHub fine-grained PATs, the token requires Contents (read and write) permission on the target repository. Classic PATs require the `repo` scope.

For GitHub Enterprise Server, keep the provider set to GitHub and enter your server host in the GitHub server URL field. Portainer Run uses the GitHub-compatible REST API at `/api/v3` on that host. Do not use the "Other" provider for GitHub Enterprise — that path targets the Gitea API.

For self-hosted GitLab, keep the provider set to GitLab and enter your server host in the GitLab server URL field. Leave it blank for gitlab.com.

Directory deletion on app removal uses the GitHub Git Data API tree approach: a single commit removes all files under a directory regardless of count, matching what the GitHub UI "Delete directory" button does. This is also implemented for GitLab (batch delete via the commits API) and Gitea.

## Roles

Portainer Run derives roles from Portainer. A user with Role 1 (admin) in Portainer is an admin in Portainer Run.

Admins see the Admin section of the navigation, which contains Cluster Readiness and full git target management including the ability to mark targets as shared. Admins can edit and delete any git target, including shared ones.

Non-admins see their own git targets plus any shared targets created by admins. Shared targets appear with a "shared" badge and are read-only for non-admins (Test is available, Edit and Delete are not).

The logged-in Portainer username is shown in the Session section of the navigation with an "admin" badge for admin users.

## Feature flags

Each deploy feature can be independently disabled by environment variable. All features default to enabled. Set any flag to `false` to disable it.

```
FEATURE_VIBE_DEPLOY=false
FEATURE_SIMPLE_DEPLOY=false
FEATURE_MANIFEST_BUILDER=false
FEATURE_CATALOGUE=false
FEATURE_SECRETS=false
```

Disabled features are hidden from the navigation and their routes redirect to the dashboard if accessed directly. The AI assistant's system prompt adapts automatically: if only Vibe Deploy is enabled, the assistant directs all deployment questions to the Vibe Deploy workflow and does not attempt to generate container-based deployment configs.

A common deployment pattern is Vibe Deploy only (`FEATURE_SIMPLE_DEPLOY=false FEATURE_MANIFEST_BUILDER=false`) to create a purpose-built landing pad for teams using AI coding tools, with all other deployment paths removed.

## MCP endpoint

Portainer Run exposes an MCP (Model Context Protocol) endpoint at `POST /mcp` that allows AI coding tools to deploy applications directly.

Authentication uses either `Authorization: Bearer <portainer-token>` or `X-API-Key: <portainer-token>`. The token is validated against Portainer's `/users/me` endpoint on first use and cached for five minutes.

Available tools:

`list_environments` — returns Kubernetes environments accessible with the provided token.

`list_namespaces` — returns namespaces in a given environment, filtered to exclude system namespaces.

`list_git_targets` — returns git targets accessible to the caller (own targets plus shared targets).

`deploy_vibe_app` — deploys source files to Kubernetes via the full Vibe Deploy pipeline. Accepts `appName`, `envId`, `namespace`, `gitTargetId`, `files` (array of `{ path, content }`), and optional `envVars`, `exposeType`, and `branch`. Auto-detects runtime and parses `.env.example` for environment variables if `envVars` is not supplied. Only available when `FEATURE_VIBE_DEPLOY` is enabled.

`get_app_status` — returns the running status of a deployed application from the server-side cache.

To connect Claude Desktop, add the following to `claude_desktop_config.json` (requires Node.js for `mcp-remote`):

```json
{
  "mcpServers": {
    "portainer-run": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://your-portainer-run/mcp",
        "--header",
        "Authorization: Bearer YOUR_PORTAINER_TOKEN"
      ]
    }
  }
}
```

Config file location: `%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.

To verify the endpoint is working before connecting a client:

```bash
curl -k -X POST https://your-portainer-run/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Catalogue

The Catalogue provides a library of pre-configured application stacks deployed in two clicks. Refer to the existing template format documentation in the previous README version for full template schema details. The default template library is fetched from `TEMPLATE_URL` and cached server-side for five minutes.

## Performance

The server exposes a `/env-status/:envId` endpoint that fans out to Kubernetes in parallel for a single environment (pods, services, ingresses, and nodes in one batch) then aggregates results into a per-deployment status map cached for 20 seconds. The browser fires one request per environment with a client-side concurrency limit of 5. A resourceVersion fingerprint means unchanged environments return cached results immediately.

## Architecture

```
Browser → Node proxy (server.js) → Portainer API
                                  → Anthropic API  (if configured)
                                  → OpenAI API     (if configured)
```

Portainer Run is a React/Vite frontend served by a Node.js proxy. The proxy forwards Kubernetes API calls to Portainer (bypassing browser CORS), relays AI requests to the configured provider (keeping the API key server-side), serves the aggregated `/env-status/` endpoint, exposes the `/mcp` MCP endpoint, and maintains a file-backed session cache.

User credentials never appear in server logs. AI API keys never reach the browser.

HTTPS runs on port 443 with a self-signed certificate by default. Port 80 redirects to HTTPS. Real certificates can be provided at runtime.

### Session cache and data persistence

The server maintains a SQLite database at `data/portainer-run.db` for git target storage and a file-backed cache at `data/cache.json` for deployment state. Both live under `/app/data` inside the container.

Mount a named Docker volume at `/app/data` to persist data across restarts:

```yaml
volumes:
  - portainer-run-data:/app/data

volumes:
  portainer-run-data:
```

Do not mount to `/app` — that would override the application itself.

`ENCRYPTION_KEY` must be set to the same value on every deploy. Git target credentials are encrypted with this key at rest. A different or missing key on redeploy means existing targets cannot be decrypted and will appear gone.

## Local development

The repo uses [Bun](https://bun.sh) for installs, scripts, and the Vite build.

```bash
bun install
bun run dev
```

Build the UI only: `bun run build:client`.

## Deployment

### Build

```bash
DOCKER_BUILDKIT=0 docker build -t portainer-run .
```

### Run examples

Minimal (Anthropic, self-signed certificate, persistent data):

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v portainer-run-data:/app/data \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=change-me-to-a-rand-32-string \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  --name portainer-run \
  portainer/portainer-run:latest
```

Vibe Deploy only (disables Simple Deploy and Manifest Builder):

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v portainer-run-data:/app/data \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=change-me-to-a-rand-32-string \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e FEATURE_SIMPLE_DEPLOY=false \
  -e FEATURE_MANIFEST_BUILDER=false \
  --name portainer-run \
  portainer/portainer-run:latest
```

Real TLS certificates:

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v portainer-run-data:/app/data \
  -v /etc/letsencrypt/live/portainer-run.example.com:/certs:ro \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=change-me-to-a-rand-32-string \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e SSL_CERT=/certs/fullchain.pem \
  -e SSL_KEY=/certs/privkey.pem \
  --name portainer-run \
  portainer/portainer-run:latest
```

Custom ports:

```bash
docker run -d \
  -p 8443:8443 \
  -p 8080:8080 \
  -v portainer-run-data:/app/data \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=change-me-to-a-rand-32-string \
  -e PORT=8443 \
  -e HTTP_PORT=8080 \
  --name portainer-run \
  portainer/portainer-run:latest
```

If the container cannot resolve your Portainer hostname (error: `EAI_AGAIN`), add `--dns 8.8.8.8` to the run command.

## Environment variables

`PORTAINER_URL` and `ENCRYPTION_KEY` are required. All others are optional.

| Variable | Default | Description |
|---|---|---|
| `PORTAINER_URL` | — | Full URL of your Portainer instance. Example: `https://portainer.example.com:9443` |
| `ENCRYPTION_KEY` | — | Encrypts stored git target credentials at rest. Must be at least 32 characters and identical across deploys. Generate with: `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | — | Anthropic API key. Enables the Assistant using Claude. |
| `OPENAI_API_KEY` | — | OpenAI API key. Enables the Assistant using GPT-4o. Set one or the other — not both. Anthropic takes priority if both are set. |
| `AI_PROVIDER` | auto | Override AI provider: `anthropic` or `openai`. Auto-detected from whichever key is set. |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model override. |
| `FEATURE_VIBE_DEPLOY` | `true` | Enable or disable the Vibe Deploy feature. |
| `FEATURE_SIMPLE_DEPLOY` | `true` | Enable or disable the Simple Deploy feature. |
| `FEATURE_MANIFEST_BUILDER` | `true` | Enable or disable the Manifest Builder feature. |
| `FEATURE_CATALOGUE` | `true` | Enable or disable the Catalogue feature. |
| `FEATURE_SECRETS` | `true` | Enable or disable the Secrets feature. |
| `TEMPLATE_URL` | (repo default) | URL of the template catalogue JSON file. Cached server-side for 5 minutes. |
| `BASE_DOMAIN` | — | Base domain for Ingress exposure. If set, templates default to `appname.BASE_DOMAIN` as the Ingress host. |
| `PORT` | `443` | HTTPS listen port inside the container. |
| `HTTP_PORT` | `80` | HTTP redirect port inside the container. |
| `SSL_CERT` | — | Path to TLS certificate file. Uses self-signed if not set. |
| `SSL_KEY` | — | Path to TLS private key file. Uses self-signed if not set. |
| `SSL_CERT_DIR` | `/app` | Directory for self-signed certificate storage. |

## Connecting

Navigate to `https://<your-host>` and enter a Portainer personal access token. Generate one in Portainer under Account → Access Tokens. The token scope determines what Portainer Run can see and do — namespace-scoped tokens require manual namespace entry on deploy; cluster-scoped tokens enumerate namespaces automatically.

Portainer's RBAC applies in full. Users with admin role in Portainer see the Admin section including Cluster Readiness and shared git target management. Non-admin users see only their own targets plus any shared targets an admin has created.

Sessions persist across page refreshes and are cleared on disconnect.

## Notes on scope

Portainer Run only surfaces deployments it created. It tags every Deployment, Service, PVC, and Ingress with `managed-by=portainer-run` and filters the Applications page to that label. Workloads deployed through Portainer's own UI or `kubectl` will not appear. Secrets are an exception — the Secrets page and secret picker show all secrets in the namespace regardless of origin.

Persistent storage volumes cannot be modified after deployment. PVCs are created at deploy time and are not touched by the Edit tab.

OAuth authentication is not supported. Users in OAuth-configured Portainer deployments should generate a personal access token in Portainer under Account → Access Tokens.
