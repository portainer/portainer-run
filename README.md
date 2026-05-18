# Portainer Run

A simplified self-service operations portal for Kubernetes, backed by the Portainer API.

## Why this exists

AI has made everyone a developer. Not a software engineer, not a full-stack engineer... a developer. Someone who can take a business problem, describe it to an AI coding tool, and get a working application out the other side. The barrier to creation has effectively gone.

The best AI-assisted development tools know this. It's why they push hosting onto their own SaaS or PaaS; it's the only way to keep the experience seamless end to end. And it works, right up until the app needs to talk to something inside your network. An internal database. An on-prem API. A system that lives behind the firewall and isn't going anywhere. At that point the experience collapses, and the only path forward is a ticket to the platform team.

That platform team is already stretched. The influx of deployment requests coming from people who have never touched infrastructure (app owners, business developers, support staff, people who vibe-coded their first container last Tuesday) is a real and growing problem with no clean answer today. Buying an IDP that takes a year to configure before anyone can use it is not the answer.

Portainer Run sits in that gap. The container image is already an artefact AI coding tools can produce. Portainer Run is the "now run it, inside your environment" layer, with the platform team's guardrails baked in via Portainer's existing RBAC and policy controls. The platform team's role shifts from processing every deployment ticket to setting the rules once.

The embedded AI fits this persona specifically. When a business developer asks "why isn't my app connecting to the database," they don't need two months of metrics and autoscaling policy work. They need the right answer, fast, without filing a ticket. That's what the AI triage layer is for.

Portainer is the secure, policy-enforced gateway between the people doing the work and the infrastructure they're working on. Portainer Run is the interface on top of that gateway, designed for the people who have no idea what a Pod is and shouldn't need to.

It is intentionally narrow in scope. It does not replace Portainer. It does not try to serve the engineer who has full cluster access and wants a powerful agent with deep API reach, that's a different product for a different persona. Portainer Run surfaces one workflow (deploy, run, and operate a containerised workload) in the simplest interface we could build for it.

Optimised for desktop and laptop screen sizes.

## What it does

Portainer Run connects to your Portainer instance using a personal access token. Access is governed entirely by your Portainer RBAC role. Once connected it provides a unified view across all Kubernetes environments your account can reach.

**Dashboard** shows a live health summary across all environments: total services, running, degraded, and unavailable counts, with a per-environment breakdown. The cache refreshes every 30 seconds automatically and after any deploy, scale, or delete action. On reconnect the last known state is shown immediately while live data loads in the background.

**Services** is the primary operational HUD. It lists all deployments tagged `managed-by=portainer-run` with a traffic light status indicator per row: a green dot for running, pulsing amber for starting up or partially available, pulsing red for not running. Status reasons are fetched from pod state and shown in plain English below the indicator. OOMKilled is suppressed until three or more restarts to avoid surfacing transient pod recycling as a problem. The exposure column shows a clickable address (node IP:nodePort for NodePort, IP:port for LoadBalancer, FQDN for Ingress). Each row has Logs, Restart, and Delete actions. Restart triggers a rolling restart via annotation patch; pods are replaced one by one with no downtime. The page auto-refreshes every 30 seconds.

**Deploy** provides a Cloud Run-style deployment form covering single-container and multi-container (sidecar) workloads, persistent storage (RWO via PVC), environment variables, Kubernetes Secrets references, resource limits including GPU, and service exposure (NodePort, LoadBalancer, Ingress). All deployments are tagged `managed-by=portainer-run`. Deployments go through the GitOps flow described below.

**Catalogue** provides one-click deployment of pre-configured application stacks. See the Catalogue section below for full details. Catalogue deployments also go through the GitOps flow.

**Git Targets** is where Git repositories are configured for GitOps deployments. Each target stores a provider (GitHub, GitLab, Gitea), repository, branch, PAT credentials, and optional path prefix. Credentials are stored AES-256-GCM encrypted at rest. A Test button validates connectivity before saving. Git targets are managed here and referenced at deploy time; they cannot be created inline during the deploy flow.

**Secrets** provides a namespace-scoped view of Kubernetes Secrets. Secrets can be created with multiple key/value pairs (values are write-only and not displayed after saving), and deleted with a confirmation prompt.

Clicking any service opens a detail panel with six tabs.

**Overview** shows live status, configuration, labels, and full exposure detail.

**Containers** shows per-container configuration: image, ports, pull policy, resource limits, environment variables, and volume mounts.

**Metrics** shows CPU and memory sparklines per container, polled every 15 seconds via `metrics.k8s.io`. Requires metrics-server on the cluster.

**Logs** streams or fetches pod logs with per-container selection, severity filtering, and text search. The AI Analyse button gathers logs, pod conditions, and Kubernetes events from all three levels (Deployment, ReplicaSet, Pod) and sends them to the configured AI provider for triage.

**Revisions** lists ReplicaSet history, most recent first, with a Rollback button per revision.

**Edit** provides live editing of instance count, container images, environment variables, and exposed ports. For GitOps-managed deployments, saving commits an updated manifest to the configured Git target and Portainer reconciles the change automatically.

**Assistant** is a persistent chat panel available on every page. It is context-aware of whatever you are looking at and can answer questions about your services in plain English, translate a Docker Compose file into a Portainer Run deployment, describe a deployment in natural language to pre-populate the deploy form, and detect scale requests to open the Edit tab pre-filled. The assistant never executes irreversible operations directly; it routes destructive actions to the existing UI. Session history is kept in memory only and cleared on disconnect.

**Cluster Readiness** (admin only) checks each environment for ingress controller availability, LoadBalancer provisioning, storage class configuration, node health, and GPU node availability. Administrators can disable environments from this page; disabled environments are hidden from all dropdowns and views for non-admin users. Disabled state is stored in a ConfigMap (`portainer-run-config` in `kube-system`) and persists across restarts.

## GitOps

All deployments in Portainer Run go through a GitOps flow. There is no direct-to-cluster deploy path.

When a user deploys a service (from the Deploy form, the Catalogue, or the AI assistant), Portainer Run generates a Kubernetes-native manifest (Deployment, Service, optional Ingress, optional PVCs) and commits it to a user-specified Git repository. Portainer then creates a GitOps-backed stack pointing at that manifest file. From that point on, Portainer polls the repository on the configured interval and applies any changes automatically.

To update a running service, the user edits it in the Edit tab. Portainer Run commits the updated manifest to the same Git path and branch; Portainer picks up the change on its next poll cycle. No direct API calls are made to the Kubernetes cluster for updates.

Each deployment carries three annotations that record where its manifest lives: `portainer-run/git-target-id`, `portainer-run/git-branch`, and `portainer-run/git-path`. These annotations are written into the manifest itself, so they travel with the Deployment and survive Portainer restarts.

When a service is deleted, Portainer Run offers the option to also remove the manifest file from the Git repository. This is opt-in and unchecked by default.

### Git targets

A Git target defines a repository, credentials, and optional path prefix. Multiple deployments can share one Git target or each have their own. Manifests are committed to `<pathPrefix>/<namespace>/<appName>.yaml` within the repository.

Supported providers: GitHub, GitLab, and Gitea (including self-hosted instances). Authentication via Personal Access Token. The PAT is stored encrypted server-side and is also passed to Portainer when the GitOps stack is created, so Portainer can poll the repository independently.

### Manifest format

Portainer Run generates standard Kubernetes manifests. Catalogue items are defined as Knative Service specs internally, but all manifests committed to Git are plain Kubernetes resources. No Knative installation is required on the target cluster.

A typical deployment produces: one or more PersistentVolumeClaims (if storage is configured), a Deployment with all containers and GitOps annotations, a Service (if exposure is configured), and an Ingress (if exposure type is Ingress).

### Dry-run validation

Before committing, the GitOps step in the deploy form provides an optional "Dry-run validate" button. This submits the manifests to the Kubernetes API with `?dryRun=All&fieldManager=portainer-run`, which validates them server-side without creating any resources. Results are shown per-resource (pass, warn, or fail) before the user confirms the deploy.

### Poll interval

The GitOps step lets the user choose how often Portainer polls the repository for changes: 5 minutes, 15 minutes, 30 minutes, 1 hour, or 24 hours. The default is 5 minutes.

## Catalogue

The Catalogue provides a library of pre-configured application stacks that can be deployed in three steps. Each template card shows the application name, category, container images, and primary port. Clicking **Deploy Wizard** opens a modal.

Step 1 selects the target environment and namespace. Step 2 shows a confirmation summary: template name, environment, namespace, containers, exposure type, and a GPU REQUIRED notice if the template requests GPU resources. From step 2, **Next** proceeds to step 3 where the Git target, branch, and poll interval are selected. **Customize** instead populates the Deploy form with the template's configuration and navigates to it, giving the user full control before deploying.

The template library is fetched from `TEMPLATE_URL` and cached server-side for 5 minutes. The built-in default is the sample catalogue on the `develop` branch of this repo. To use your own catalogue, set `TEMPLATE_URL` to any publicly accessible JSON file matching the format below.

### Template file format

Templates are served as a JSON file:

```json
{
  "version": "1",
  "templates": [ ... ]
}
```

Each template entry fields: `id` (unique string, lowercase with hyphens), `name` (display name), `description` (one to two sentences), `category` (one of: `cms`, `database`, `web`, `monitoring`, `messaging`, `devtools`), `icon` (reserved for future use), and `manifest` (a Knative Service manifest used as a multi-container schema).

The manifest is parsed as follows. `metadata.name` becomes the deployment name. `metadata.annotations["autoscaling.knative.dev/minScale"]` becomes the instance count. Each entry in `spec.template.spec.containers` becomes a container. The first container's `ports[0].containerPort` determines the exposure port. `spec.template.spec.volumes` entries with `persistentVolumeClaim` become PVCs. GPU resources in container `resources.limits` are detected and surfaced in the wizard confirmation step.

A minimal single-container template:

```json
{
  "id": "nginx",
  "name": "Nginx",
  "description": "Nginx web server. Use as a static file server or reverse proxy.",
  "category": "web",
  "icon": "nginx",
  "manifest": {
    "apiVersion": "serving.knative.dev/v1",
    "kind": "Service",
    "metadata": {
      "name": "nginx",
      "annotations": { "autoscaling.knative.dev/minScale": "1" }
    },
    "spec": {
      "template": {
        "spec": {
          "containers": [
            {
              "name": "nginx",
              "image": "nginx:latest",
              "ports": [{ "containerPort": 80 }],
              "resources": {
                "requests": { "cpu": "50m", "memory": "64Mi" },
                "limits": { "cpu": "200m", "memory": "128Mi" }
              }
            }
          ]
        }
      }
    }
  }
}
```

## Performance

At scale (dozens of clusters, hundreds of workloads) the naive approach of firing individual pod, service, ingress, and node API calls per deployment would saturate both the browser and the Portainer proxy. Portainer Run uses an aggregated approach instead.

The server exposes a `/env-status/:envId` endpoint that fans out to Kubernetes in parallel for a single environment (one call each for pods, services, ingresses, and nodes), aggregates the results into a per-deployment status map, and caches the response for 20 seconds keyed by a hash of the token and environment ID. The browser fires one request per environment rather than one per deployment, with a client-side concurrency limit of 5 simultaneous environment fetches.

## Architecture

```
Browser → Node proxy (server.js) → Portainer API
                                  → Anthropic API  (if configured)
                                  → OpenAI API     (if configured)
                                  → Git provider   (GitHub / GitLab / Gitea)
```

Portainer Run is a Vite/React frontend served by a Bun HTTPS proxy. The proxy handles Kubernetes API calls to Portainer (bypassing browser CORS), AI requests to the configured provider (keeping the API key server-side), the aggregated `/env-status/` endpoint, Git operations for GitOps deploy and update flows, and a file-backed session cache.

The user's credentials never appear in server logs. AI API keys and Git PATs never reach the browser. Git PATs are stored AES-256-GCM encrypted in a SQLite database at `data/portainer-run.db`.

The proxy serves HTTPS on port 443 with a self-signed certificate by default. Port 80 redirects to HTTPS. Real certificates can be provided at runtime.

### Session cache

The server maintains a file-backed cache at `data/cache.json`. On reconnect, the last known deployment state is shown immediately while live data loads in the background. The cache is keyed by a SHA-256 hash of the user's token. Mount `data/` as a Docker volume to persist the cache and Git target database across container restarts.

### Git target storage

Git target credentials are stored in a SQLite database at `data/portainer-run.db`, encrypted with AES-256-GCM. The encryption key must be provided as `ENCRYPTION_KEY` in the environment. Without it the server will start but refuse to store Git targets. Generate a suitable key with `openssl rand -hex 32`.

### Environment disable/enable

Administrators can disable environments from the Cluster Readiness page. Disabled environments are hidden from all dropdowns and views for non-admin users and blocked from receiving new deployments for everyone. The disabled state is stored in a ConfigMap named `portainer-run-config` in the `kube-system` namespace.

## Files

`server/` — Bun HTTPS proxy, static UI server, env-status aggregator, GitOps orchestration, and session cache. Entry: `server/server.js`.
`server/db/` — SQLite database init and schema.
`server/models/` — encrypted Git target connection model.
`server/routes/` — connections REST API and GitOps deploy/update/validate/manifest routes.
`server/proxy/git.js` — Git provider operations (commit, branch, delete file) for GitHub, GitLab, and Gitea.
`server/lib/manifestSerialize.js` — Kubernetes manifest builder and YAML serializer.
`client/` — Vite + React application.
`client/public/portainer-logo.png` — PORTAINER.IO wordmark used in the header and login page.
`templates.json` — sample application catalogue; the default `TEMPLATE_URL` points at this file on GitHub raw.
`Dockerfile` — two-stage build: `oven/bun:1-alpine` builds the client and runs the server.
`.env.example` — environment variable reference.

## Local development

The repo uses [Bun](https://bun.sh) for installs, scripts, and the Vite build.

```bash
bun install
bun run dev
```

Build the UI only: `bun run build:client` (or `cd client && bun run build`).

## Deployment

### Build

```bash
docker build --no-cache -t portainer-run .
```

### Run (with GitOps, Anthropic, self-signed certificate)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v portainer-run-data:/app/data \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  --name portainer-run \
  portainer-run
```

The `-v portainer-run-data:/app/data` mount persists the SQLite database (Git targets and credentials) and the session cache across container restarts. Without it, Git targets are lost on every restart.

### Run (OpenAI)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v portainer-run-data:/app/data \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e OPENAI_API_KEY=sk-... \
  --name portainer-run \
  portainer-run
```

### Run (real certificates)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v portainer-run-data:/app/data \
  -v /path/to/certs:/certs \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e SSL_CERT=/certs/fullchain.pem \
  -e SSL_KEY=/certs/privkey.pem \
  --name portainer-run \
  portainer-run
```

### Run (custom template catalogue)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v portainer-run-data:/app/data \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e TEMPLATE_URL=https://your-server.com/templates.json \
  --name portainer-run \
  portainer-run
```

### Run (custom ports)

```bash
docker run -d \
  -p 8443:8443 \
  -p 8080:8080 \
  -v portainer-run-data:/app/data \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e PORT=8443 \
  -e HTTP_PORT=8080 \
  --name portainer-run \
  portainer-run
```

### DNS resolution issues

If the container cannot resolve your Portainer hostname (error: `EAI_AGAIN`), add `--dns 8.8.8.8` to the run command.

On first start the container generates a self-signed TLS certificate (3 year validity). The browser will warn about the certificate on first access; accept the exception to proceed.

## Environment variables

`PORTAINER_URL` and `ENCRYPTION_KEY` are required. All others are optional.

| Variable | Default | Description |
|---|---|---|
| `PORTAINER_URL` | — | Full URL of your Portainer instance. Example: `https://portainer.example.com:9443` |
| `ENCRYPTION_KEY` | — | 32+ character random string for encrypting Git target credentials at rest. Generate with `openssl rand -hex 32`. |
| `ANTHROPIC_API_KEY` | — | Anthropic API key. Enables the Assistant and AI triage using Claude. |
| `OPENAI_API_KEY` | — | OpenAI API key. Enables the Assistant and AI triage using GPT-4o. Set one or the other, not both. Anthropic takes priority if both are set. |
| `AI_PROVIDER` | auto | Override AI provider: `anthropic` or `openai`. Auto-detected from whichever key is set. |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model override. |
| `TEMPLATE_URL` | (repo default) | URL of the template catalogue JSON file. Cached server-side for 5 minutes. |
| `BASE_DOMAIN` | — | Base domain for Ingress exposure. If set, templates default to `appname.BASE_DOMAIN` as the Ingress host. |
| `PORT` | `443` | HTTPS listen port inside the container. |
| `HTTP_PORT` | `80` | HTTP redirect port inside the container. |
| `SSL_CERT` | — | Path to TLS certificate file. Uses self-signed if not set. |
| `SSL_KEY` | — | Path to TLS private key file. Uses self-signed if not set. |
| `SSL_CERT_DIR` | `/app` | Directory for self-signed certificate storage. |
| `CACHE_DIR` | `/app/data` | Directory for session cache and SQLite database. Mount as a volume to persist across restarts. |

## Connecting

Navigate to `https://<your-host>` and enter a Portainer personal access token. Generate one in Portainer under Account → Access Tokens. The token scope determines what Portainer Run can see and do — namespace-scoped tokens will require manual namespace entry on deploy; cluster-scoped tokens enumerate namespaces automatically.

Portainer's RBAC applies in full. Users with admin role in Portainer see the Cluster Readiness page and environment disable/enable controls. Non-admin users see only enabled environments.

Sessions persist across page refreshes for up to 1 hour of inactivity. The timer slides forward on each successful data refresh, so active sessions stay alive indefinitely. Sessions are cleared immediately on disconnect.

## Assistant

The Assistant requires either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to be configured on the server. Without it the Assistant button is not shown.

When answering health or performance questions the Assistant automatically fetches diagnostic data (logs, pod conditions, Kubernetes events) before generating a response. It does not ask you to check these yourself.

Docker Compose files can be pasted directly into the Assistant input. It will translate the compose file into Portainer Run's deployment model, show a preview, and populate the deploy form. Build directives and network aliases are flagged as unmappable.

The Assistant is scoped to container operations only and will decline unrelated questions. Session history is kept in memory only and cleared on disconnect.

## Notes on scope

By design, Portainer Run only surfaces deployments it created. It tags every Deployment, Service, PVC, and Ingress with `managed-by=portainer-run` and filters all views to that label. Workloads deployed through Portainer's own UI or `kubectl` will not appear. Secrets are an exception — the Secrets page and the secret picker in the Deploy form show all secrets in the namespace regardless of origin.

Persistent storage volumes cannot be modified after deployment. PVCs are created at deploy time and are not touched by the Edit tab.

OAuth authentication is not currently supported. Users in OAuth-configured Portainer deployments should generate a personal access token in Portainer under Account → Access Tokens.
