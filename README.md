# Portainer-Run

A self-service deployment portal for Kubernetes, backed by the Portainer API. Portainer-Run sits between people who can build applications with AI coding tools and the Kubernetes infrastructure those applications need to run on.

## Quick start

Deploy Portainer-Run then access it at `https://your-ip-address/`.

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

The best AI-assisted development tools know this. It is why they push hosting onto their own SaaS or PaaS: it is the only way to keep the experience seamless end to end. And it works, right up until the app needs to talk to something inside your network. An internal database. An on-prem API. A system that lives behind the firewall and is not going anywhere. At that point the experience collapses, and the only path forward is a ticket to the platform team.

That platform team is already stretched. The influx of deployment requests coming from people who have never touched infrastructure is a real and growing problem with no clean answer today. Buying an IDP that takes a year to configure before anyone can use it is not the answer.

Portainer-Run sits in that gap. The source folder an AI coding tool produces is already an artifact. Portainer-Run is the "now run it, inside your environment" layer, with the platform team's guardrails baked in via Portainer's existing RBAC and policy controls. The platform team's role shifts from processing every deployment ticket to setting the rules once.

## What it does

Portainer-Run connects to your Portainer instance using a personal access token. Access is governed entirely by your Portainer RBAC role. Once connected it provides a unified view across all Kubernetes environments your account can reach.

**Applications** is the primary operational view and the landing page after login. It lists all deployments tagged `managed-by=portainer-run` with a traffic light status per row, sortable by name, environment, health, or creation date. Status reasons are read from pod state and shown in plain English: "App keeps crashing (4 restarts)", "Can't download the image", "No node has enough resources", and so on. The access column shows a clickable address, and a Deployed by column shows who created each application, which is useful where a project space is shared across a team. Each row has Logs, Restart, and Delete actions. A **+ Deploy** button in the page header opens the Deploy page.

There is no separate Dashboard page. Applications serves that role.

**Deploy** is the path for source files produced by AI coding tools. Drop the files the AI tool generated, and Portainer-Run handles runtime detection, dependency installation, git commit, and Kubernetes deployment automatically. No Dockerfile, no CI pipeline, no container registry required.

The runtime is detected from the file structure. A `package.json` maps to Node.js. A `requirements.txt` maps to Python. A `Gemfile` maps to Ruby. `.php` files map to PHP with Apache. Everything else defaults to nginx for static HTML, CSS, and JavaScript.

On deploy, up to three init containers run before the app starts: the first clones source files from git into a PersistentVolume, the second runs the dependency installer (`npm install`, `pip install`, and so on) in the correct runtime image, and the third writes a `.env` file from the entered environment variables. None of this requires a build step. Every application is deployed with sane resource requests and limits: a request of 0.1 CPU and 1Gi of memory, and a limit of 1 CPU and 4Gi of memory. These values live in the committed manifest, so a platform administrator can adjust them in git if a workload needs more.

If uploaded files include a `.env.example`, Portainer-Run detects it and presents an editable list of keys before deploying. Keys matching common patterns (SECRET, TOKEN, KEY, PASSWORD) are masked in the form.

Deploy also supports deploying directly from an existing git repository. Instead of uploading files, select a configured git target, branch, and optional subfolder. Portainer-Run fetches the file listing, detects the runtime, and clones directly from that source repository on every pod start.

Clicking any application opens a detail panel with tabs for Overview, Containers, Metrics, Logs, Revisions, and Edit. The Edit tab reads the committed manifest back and lets you change how the app is exposed, adjust or add environment variables, and upload a revised set of source files. Environment variable changes are written back to the manifest in git (both the container environment and the generated `.env` file), and Portainer reconciles on the next poll cycle.

**Cluster Readiness** (admin only) checks each environment for ingress, LoadBalancer, storage, node health, and GPU availability, and lets administrators disable environments from the deploy flow.

**Assistant** is a persistent chat panel available on every page. It is context-aware and fetches live diagnostic data before answering health questions. It directs all deployment questions to the Deploy workflow and never executes irreversible operations directly.

## Git targets

Deploy commits manifests and source files to a git repository. A git target is a stored, encrypted connection to a repository. Git targets are per-user: each user's targets are only visible to themselves. Administrators can additionally mark targets as shared, making them available to all users in the deploy flow while remaining read-only for non-admins.

Manifests are committed to `<env-name>/<namespace>/<appname>.yaml` and source files to `<env-name>/<namespace>/<appname>/src/`. This structure keeps each deployment environment cleanly separated within the repository. The browser UI and the MCP endpoint use the same paths, so an app deployed either way lands in the same place.

Each target stores the provider (GitHub, GitLab, Gitea, or other), the repository in `owner/repo` form, a personal access token, an optional path prefix, and a default branch. Credentials are encrypted at rest using `ENCRYPTION_KEY`. This key must remain identical across deploys or stored targets become unreadable.

The Test button on each target checks connectivity and reports read and write permissions. For GitHub, the check uses the collaborator permissions API, which works correctly with fine-grained PATs. For GitHub fine-grained PATs, the token requires Contents (read and write) permission on the target repository. Classic PATs require the `repo` scope.

For GitHub Enterprise Server, keep the provider set to GitHub and enter your server host in the GitHub server URL field. Portainer-Run uses the GitHub-compatible REST API at `/api/v3` on that host. Do not use the "Other" provider for GitHub Enterprise: that path targets the Gitea API.

For self-hosted GitLab, keep the provider set to GitLab and enter your server host in the GitLab server URL field. Leave it blank for gitlab.com.

Directory deletion on app removal uses the GitHub Git Data API tree approach: a single commit removes all files under a directory regardless of count, matching what the GitHub UI "Delete directory" button does. This is also implemented for GitLab (batch delete via the commits API) and Gitea.

## Roles

Portainer-Run derives roles from Portainer. A user with Role 1 (admin) in Portainer is an admin in Portainer-Run.

Admins see the Admin section of the navigation, which contains Cluster Readiness and full git target management including the ability to mark targets as shared. Admins can edit and delete any git target, including shared ones.

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
      ]
    }
  }
}
```

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
Browser → Bun HTTPS server (server.js) → Portainer API
                                        → Anthropic API  (if configured)
                                        → OpenAI API     (if configured)
```

Portainer-Run is a React and Vite frontend served by a Bun HTTPS server. The server forwards Kubernetes API calls to Portainer (bypassing browser CORS), relays AI requests to the configured provider (keeping the API key server-side), serves the aggregated `/env-status/` endpoint, exposes the `/mcp` MCP endpoint, and maintains a file-backed session cache.

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

Do not mount to `/app`: that would override the application itself.

`ENCRYPTION_KEY` must be set to the same value on every deploy. Git target credentials are encrypted with this key at rest. A different or missing key on redeploy means existing targets cannot be decrypted and will appear gone.

## Local development

The repo uses [Bun](https://bun.sh) for installs, scripts, and the Vite build.

```bash
bun install
bun run dev
```

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
| `PORTAINER_URL` | (required) | Full URL of your Portainer instance. Example: `https://portainer.example.com:9443` |
| `ENCRYPTION_KEY` | (required) | Encrypts stored git target credentials at rest. Must be at least 32 characters and identical across deploys. Generate with: `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | (none) | Anthropic API key. Enables the Assistant using Claude. |
| `OPENAI_API_KEY` | (none) | OpenAI API key. Enables the Assistant using GPT-4o. Set one or the other, not both. Anthropic takes priority if both are set. |
| `AI_PROVIDER` | auto | Override AI provider: `anthropic` or `openai`. Auto-detected from whichever key is set. |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model override. |
| `BASE_DOMAIN` | (none) | Base domain for Ingress exposure. If set, the deploy flow defaults the Ingress host to `appname.BASE_DOMAIN`. |
| `GATEWAY_URL` | (none) | File relay gateway for staged uploads. When set, large deploy uploads use the gateway instead of inline MCP transfer. |
| `PORT` | `443` | HTTPS listen port inside the container. |
| `HTTP_PORT` | `80` | HTTP redirect port inside the container. |
| `SSL_CERT` | (none) | Path to TLS certificate file. Uses self-signed if not set. |
| `SSL_KEY` | (none) | Path to TLS private key file. Uses self-signed if not set. |
| `SSL_CERT_DIR` | `/app` | Directory for self-signed certificate storage. |

## Connecting

Navigate to `https://<your-host>` and enter a Portainer personal access token. Generate one in Portainer under Account, then Access Tokens. The token scope determines what Portainer-Run can see and do: namespace-scoped tokens require manual namespace entry on deploy; cluster-scoped tokens enumerate namespaces automatically.

Portainer's RBAC applies in full. Users with admin role in Portainer see the Admin section including Cluster Readiness and shared git target management. Non-admin users see only their own targets plus any shared targets an admin has created.

Sessions persist across page refreshes and are cleared on disconnect.

## Notes on scope

Portainer-Run only surfaces deployments it created. It tags every Deployment, Service, PVC, and Ingress with `managed-by=portainer-run` and filters the Applications page to that label. Workloads deployed through Portainer's own UI or `kubectl` will not appear.

Persistent storage volumes cannot be modified after deployment. PVCs are created at deploy time and are not touched by the Edit tab.

OAuth authentication is not supported. Users in OAuth-configured Portainer deployments should generate a personal access token in Portainer under Account, then Access Tokens.
