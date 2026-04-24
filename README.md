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

**Services** is the primary operational HUD. It lists all deployments tagged `managed-by=portainer-run` with a traffic light status indicator per row: a green dot for running, pulsing amber for starting up or partially available, pulsing red for not running. Status reasons are fetched from pod state and shown in plain English below the indicator; "App keeps crashing (4 restarts)", "Can't download the image", "No node has enough resources", "No compatible node found", and so on. OOMKilled is suppressed until three or more restarts to avoid surfacing transient pod recycling as a problem. The exposure column shows a clickable address (node IP:nodePort for NodePort, IP:port for LoadBalancer, FQDN for Ingress). Each row has Logs, Restart, and Delete actions. Restart triggers a rolling restart via annotation patch; pods are replaced one by one with no downtime. The page auto-refreshes every 30 seconds.

**Deploy** provides a Cloud Run-style deployment form covering single-container and multi-container (sidecar) workloads, persistent storage (RWO via PVC), environment variables, Kubernetes Secrets references, resource limits including GPU, and service exposure (NodePort, LoadBalancer, Ingress). All deployments are tagged `managed-by=portainer-run`.

Environment variables can be set as plain values, as references to individual keys from a Kubernetes Secret (`valueFrom.secretKeyRef`), or as a full secret injection (`envFrom.secretRef`) that maps every key in a secret to an environment variable automatically. Any secret in the namespace is available regardless of whether it was created through Portainer Run.

GPU support is per-container. Enabling the GPU toggle auto-detects the GPU resource type available on the selected environment's nodes (NVIDIA, AMD, Intel, or Habana) and sets the correct resource key in both requests and limits. A warning is shown if no GPU nodes are found in the environment.

**Catalogue** provides one-click deployment of pre-configured application stacks. See the Catalogue section below for full details.

**Secrets** provides a namespace-scoped view of Kubernetes Secrets. Secrets can be created with multiple key/value pairs (values are write-only — they are base64-encoded before storage and not displayed after saving), and deleted with a confirmation prompt. The create form targets a specific environment and namespace independently of the list filter. Any app using a secret is shown on the secret card.

Clicking any service opens a detail panel with six tabs.

**Overview** shows live status, configuration, labels, and full exposure detail.

**Containers** shows per-container configuration: image, ports, pull policy, resource limits, environment variables, and volume mounts.

**Metrics** shows CPU and memory sparklines per container, polled every 15 seconds via `metrics.k8s.io`. Requires metrics-server on the cluster.

**Logs** streams or fetches pod logs with per-container selection, severity filtering, and text search. The AI Analyse button gathers logs, pod conditions, and Kubernetes events from all three levels (Deployment, ReplicaSet, Pod) and sends them to the configured AI provider for triage. This covers failure modes where no logs exist yet (scheduling failures, image pull errors, resource constraints) because it reads from events rather than relying on application output.

**Revisions** lists ReplicaSet history, most recent first, with a Rollback button per revision.

**Edit** provides live editing of instance count, container images, environment variables, and exposed ports. One Save button patches the Deployment and Service in a single operation.

**Assistant** is a persistent chat panel available on every page. It is context-aware of whatever you are looking at (current page, open service, environment) and can answer questions about your services in plain English, proactively fetch logs and events before responding to health questions, translate a Docker Compose file into a Portainer Run deployment, describe a deployment in natural language to pre-populate the deploy form, and detect scale requests to open the Edit tab pre-filled. The assistant never executes irreversible operations directly, it routes destructive actions to the existing UI. Session history is kept in memory only and cleared on disconnect.

**Cluster Readiness** (admin only) checks each environment for ingress controller availability, LoadBalancer provisioning, storage class configuration, node health, and GPU node availability. Each check reports a plain-English result. Administrators can disable environments from this page; disabled environments are hidden from all dropdowns and views for non-admin users, and blocked from receiving new deployments for everyone. Disabled state is stored in a ConfigMap (`portainer-run-config` in `kube-system`) and persists across restarts. Non-admin users see a notice on the dashboard if environments have been hidden.

## Catalogue

The Catalogue provides a library of pre-configured application stacks that can be deployed in two clicks. Each template card shows the application name, category, container images, and primary port. Clicking **Deploy Wizard** opens a two-step modal.

Step 1 selects the target environment and namespace. Namespaces are fetched live from the cluster and filtered to those the token can reach. Step 2 shows a confirmation summary: template name, environment, namespace, containers, exposure type, and a GPU REQUIRED notice if the template requests GPU resources. From step 2, **Deploy Now** fires the full deployment sequence directly (PVCs, Deployment, Service) without touching the Deploy form. **Customize** instead populates the Deploy form with the template's configuration, navigates to it, and pre-sets the environment and namespace; giving the user full control before deploying.

The template library is fetched from `TEMPLATE_URL` and cached server-side for 5 minutes. By default it points to the templates file in this repository. To use your own catalogue, set `TEMPLATE_URL` to any publicly accessible JSON file matching the format below.

### Template file format

Templates are served as a JSON file with the following structure:

```json
{
  "version": "1",
  "templates": [ ... ]
}
```

Each template entry has these fields.

`id` — unique string identifier, lowercase with hyphens.

`name` — display name shown on the card and in the wizard.

`description` — one or two sentences describing the application and its intended use.

`category` — one of: `cms`, `database`, `web`, `monitoring`, `messaging`, `devtools`. Controls the filter pills on the Catalogue page.

`icon` — string identifier for the application icon (reserved for future use).

`manifest` — a Knative Service manifest (`apiVersion: serving.knative.dev/v1`, `kind: Service`). Portainer Run parses this to extract container images, environment variables, resource limits, volume requirements, and instance count. A Knative installation is not required — the manifest format is used as a convenient multi-container schema.

The manifest is parsed as follows. `metadata.name` becomes the deployment name. `metadata.annotations["autoscaling.knative.dev/minScale"]` becomes the instance count. Each entry in `spec.template.spec.containers` becomes a container in the deployment. The first container's `ports[0].containerPort` determines the exposure port. `spec.template.spec.volumes` entries with `persistentVolumeClaim` become PVCs. GPU resources in container `resources.limits` (keys `nvidia.com/gpu`, `amd.com/gpu`, `gpu.intel.com/i915`, `habana.ai/gaudi`) are detected and surfaced in the wizard confirmation step.

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

A multi-container template with persistent volumes:

```json
{
  "id": "wordpress-mysql",
  "name": "WordPress + MySQL",
  "description": "WordPress CMS with a MySQL 8 database.",
  "category": "cms",
  "icon": "wordpress",
  "manifest": {
    "apiVersion": "serving.knative.dev/v1",
    "kind": "Service",
    "metadata": {
      "name": "wordpress",
      "annotations": { "autoscaling.knative.dev/minScale": "1" }
    },
    "spec": {
      "template": {
        "spec": {
          "containers": [
            {
              "name": "wordpress",
              "image": "wordpress:latest",
              "ports": [{ "containerPort": 80 }],
              "env": [
                { "name": "WORDPRESS_DB_HOST", "value": "localhost" },
                { "name": "WORDPRESS_DB_PASSWORD", "value": "changeme" }
              ],
              "resources": {
                "requests": { "cpu": "100m", "memory": "128Mi" },
                "limits": { "cpu": "500m", "memory": "512Mi" }
              },
              "volumeMounts": [{ "name": "wordpress-data", "mountPath": "/var/www/html" }]
            },
            {
              "name": "mysql",
              "image": "mysql:8.0",
              "env": [
                { "name": "MYSQL_DATABASE", "value": "wordpress" },
                { "name": "MYSQL_RANDOM_ROOT_PASSWORD", "value": "1" }
              ],
              "resources": {
                "requests": { "cpu": "100m", "memory": "256Mi" },
                "limits": { "cpu": "500m", "memory": "512Mi" }
              },
              "volumeMounts": [{ "name": "mysql-data", "mountPath": "/var/lib/mysql" }]
            }
          ],
          "volumes": [
            { "name": "wordpress-data", "persistentVolumeClaim": { "claimName": "wordpress-data" } },
            { "name": "mysql-data", "persistentVolumeClaim": { "claimName": "mysql-data" } }
          ]
        }
      }
    }
  }
}
```

Default environment variable values in templates are applied as-is at deploy time. Users who select Customize instead of Deploy Now can change them in the Deploy form before deploying. Credentials in templates should be treated as defaults to replace, not production values.

## Performance

At scale (dozens of clusters, hundreds of workloads) the naive approach of firing individual pod, service, ingress, and node API calls per deployment would saturate both the browser and the Portainer proxy. Portainer Run uses an aggregated approach instead.

The server exposes a `/env-status/:envId` endpoint that accepts the user's token and fans out to Kubernetes in parallel for a single environment (one call each for pods, services, ingresses, and nodes) then aggregates the results into a per-deployment status map (status reason and access URL) and caches the response for 20 seconds keyed by a hash of the token and environment ID. The browser fires one request per environment rather than one per deployment, with a client-side concurrency limit of 5 simultaneous environment fetches. A resourceVersion fingerprint per environment means that if nothing has changed since the last render, the cached result is applied to the DOM immediately with no network call.

## Architecture

```
Browser → Node proxy (server.js) → Portainer API
                                  → Anthropic API  (if configured)
                                  → OpenAI API     (if configured)
```

Portainer Run is a single HTML file served by a small Node.js proxy. The proxy handles four things: it forwards Kubernetes API calls to Portainer (bypassing browser CORS), it relays AI requests to the configured provider (keeping the API key server-side), it serves the aggregated `/env-status/` endpoint, and it maintains a file-backed session cache keyed by a hash of the user's token.

The user's credentials never appear in server logs. AI API keys never reach the browser.

The proxy serves HTTPS on port 443 with a self-signed certificate by default. Port 80 redirects to HTTPS. Real certificates can be provided at runtime.

### Session cache

The server maintains a file-backed cache at `data/cache.json` (configurable via `CACHE_DIR`). On reconnect, the last known deployment state is shown immediately while live data loads in the background. The cache is keyed by a SHA-256 hash of the user's token and cleared on disconnect. Mount `CACHE_DIR` as a Docker volume to persist the cache across container restarts.

### Environment disable/enable

Administrators can disable environments from the Cluster Readiness page. Disabled environments are hidden from all dropdowns and views for non-admin users, and blocked from receiving new deployments for everyone including admins. The disabled state is stored in a ConfigMap named `portainer-run-config` in the `kube-system` namespace and persists across Portainer Run restarts. The server tries each connected environment in turn to find one with access to `kube-system`; the first that succeeds is used for reads and writes.

## Files

`server/` — Node.js (or Bun) HTTPS proxy, static UI, env-status aggregator, and session cache. Entry: `server/server.js`.
`client/` — Vite + React application (current UI).
`old-implementation/` — archived monolith: `portainer-run.html` (original single-file frontend) and `templates.json` (sample application catalogue). The server can still fall back to the HTML if `client/dist` is not present.
`Dockerfile` — multi-stage build: `oven/bun:1-alpine` builds the client and runs the API; includes `openssl` for certificate generation.
`.env.example` — environment variable reference.

## Local development

The repo uses [Bun](https://bun.sh) for installs, scripts, and the Vite build (not npm).

```bash
bun install
bun run dev
```

Build the UI only: `bun run build:client` (or `cd client && bun run build`).

## Deployment

### Build

```bash
DOCKER_BUILDKIT=0 docker build -t portainer-run .
```

### Build and run (local container)

From the repo root, builds the image and starts a detached container (default host ports **9443** → HTTPS, **9080** → HTTP redirect):

```bash
./scripts/docker-run.sh
# or: bun run docker:run
```

Override ports or image name if needed:

```bash
HOST_HTTPS=443 HOST_HTTP=80 IMAGE=portainer-run:local ./scripts/docker-run.sh
```

Pass extra `docker run` flags (e.g. env vars) via `DOCKER_RUN_EXTRA`:

```bash
DOCKER_RUN_EXTRA='-e PORTAINER_URL=https://portainer.example.com:9443' ./scripts/docker-run.sh
```

### Run (Anthropic, self-signed certificate)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  --name portainer-run \
  portainer-run
```

### Run (OpenAI)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e OPENAI_API_KEY=sk-... \
  --name portainer-run \
  portainer-run
```

### Run (real certificates)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v /path/to/certs:/certs \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e SSL_CERT=/certs/fullchain.pem \
  -e SSL_KEY=/certs/privkey.pem \
  --name portainer-run \
  portainer-run
```

### Run (persistent cache across restarts)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -v /data/portainer-run:/app/data \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  --name portainer-run \
  portainer-run
```

### Run (custom template catalogue)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e TEMPLATE_URL=https://your-server.com/templates.json \
  --name portainer-run \
  portainer-run
```

### Run (custom ports)

```bash
docker run -d \
  -p 8443:8443 \
  -p 8080:8080 \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e PORT=8443 \
  -e HTTP_PORT=8080 \
  --name portainer-run \
  portainer-run
```

### DNS resolution issues

If the container cannot resolve your Portainer hostname (error: `EAI_AGAIN`), add `--dns 8.8.8.8` to the run command.

On first start the container generates a self-signed TLS certificate (3 year validity). The browser will warn about the certificate on first access; accept the exception to proceed.

## Environment variables

`PORTAINER_URL` is required. All others are optional.

| Variable | Default | Description |
|---|---|---|
| `PORTAINER_URL` | — | Full URL of your Portainer instance. Example: `https://portainer.example.com:9443` |
| `ANTHROPIC_API_KEY` | — | Anthropic API key. Enables the Assistant and AI triage using Claude. |
| `OPENAI_API_KEY` | — | OpenAI API key. Enables the Assistant and AI triage using GPT-4o. Set one or the other — not both. Anthropic takes priority if both are set. |
| `AI_PROVIDER` | auto | Override AI provider: `anthropic` or `openai`. Auto-detected from whichever key is set. |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model override. |
| `TEMPLATE_URL` | (repo default) | URL of the template catalogue JSON file. Cached server-side for 5 minutes. |
| `BASE_DOMAIN` | — | Base domain for Ingress exposure. If set, templates default to `appname.BASE_DOMAIN` as the Ingress host. |
| `PORT` | `443` | HTTPS listen port inside the container. |
| `HTTP_PORT` | `80` | HTTP redirect port inside the container. |
| `SSL_CERT` | — | Path to TLS certificate file. Uses self-signed if not set. |
| `SSL_KEY` | — | Path to TLS private key file. Uses self-signed if not set. |
| `SSL_CERT_DIR` | `/app` | Directory for self-signed certificate storage. |
| `CACHE_DIR` | `/app/data` | Directory for session cache file. Mount as a volume to persist across restarts. |

## Connecting

Navigate to `https://<your-host>` and enter a Portainer personal access token. Generate one in Portainer under Account → Access Tokens. The token scope determines what Portainer Run can see and do — namespace-scoped tokens will require manual namespace entry on deploy; cluster-scoped tokens enumerate namespaces automatically.

Portainer's RBAC applies in full. Users with admin role in Portainer see the Cluster Readiness page and environment disable/enable controls. Non-admin users see only enabled environments.

Sessions persist across page refreshes and are cleared on disconnect or when the browser tab is closed.

## Assistant

The Assistant requires either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to be configured on the server. Without it the Assistant button is not shown.

When answering health or performance questions the Assistant automatically fetches diagnostic data (logs, pod conditions, Kubernetes events) before generating a response. It does not ask you to check these yourself.

Docker Compose files can be pasted directly into the Assistant input. It will translate the compose file into Portainer Run's deployment model (all services become containers in a single pod sharing localhost), show a preview, and populate the deploy form. Build directives and network aliases are flagged as unmappable.

The Assistant is scoped to container operations only and will decline unrelated questions. Session history is kept in memory only and cleared on disconnect.

## Notes on scope

BY design, Portainer Run only surfaces deployments it created. It tags every Deployment, Service, PVC, and Ingress with `managed-by=portainer-run` and filters all views to that label. Workloads deployed through Portainer's own UI or `kubectl` will not appear. Secrets are an exception — the Secrets page and the secret picker in the Deploy form show all secrets in the namespace regardless of origin, because referencing externally-managed secrets is a normal operational requirement.

Persistent storage volumes cannot be modified after deployment. PVCs are created at deploy time and are not touched by the Edit tab.

OAuth authentication is not currently supported. Users in OAuth-configured Portainer deployments should generate a personal access token in Portainer under Account → Access Tokens.
