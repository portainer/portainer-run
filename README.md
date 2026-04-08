# Portainer Run

A Google Cloud Run-style interface for Kubernetes, backed by the Portainer API. Built as a proof-of-concept for the Internal Platform Operations Portal (IPOP) — a self-service container operations portal for internal teams.

## Why this exists

Portainer is an operator control plane. It is built for the people who manage infrastructure, not for the developers and app owners who deploy and operate applications on top of it. That distinction matters in practice: a developer who needs to ship a container, check its logs, or roll back a bad image does not need the full surface area of Portainer's UI. They need something that gets out of their way.

Portainer Run is that interface. It presents a service-centric view of your Kubernetes environments — deploy a container, see it running, stream its logs, inspect its revisions, and get AI-assisted diagnostics when something goes wrong. The underlying platform is still Portainer, with all the RBAC and access controls that implies. Portainer Run removes the distance between the user and the outcome.

It is intentionally narrow in scope. It does not replace Portainer. It surfaces a specific workflow (deploy and operate a containerised workload) in the simplest UI we could build for it.

## What it does

Portainer Run connects to your Portainer instance using either username/password credentials or a personal access token. Access is governed entirely by your Portainer RBAC role. Once connected it provides a unified view across all Kubernetes environments your account can reach.

**Dashboard** shows a live health summary across all environments: total services, running, degraded, and unavailable counts, with a per-environment breakdown. The cache refreshes every 60 seconds automatically and after any deploy, scale, or delete action. On reconnect the last known state is shown immediately while live data loads in the background.

**Services** lists all deployments tagged `managed-by=portainer-run`, showing name, image, environment, status, exposure, and age at a glance.

**Deploy** provides a Cloud Run-style deployment form covering single-container and multi-container (sidecar) workloads, persistent storage (RWO via PVC), environment variables, resource limits, and service exposure (NodePort, LoadBalancer, Ingress). All deployments are tagged `managed-by=portainer-run`.

Clicking any service opens a detail panel with six tabs.

**Overview** shows live status, configuration, labels, and full exposure detail.

**Containers** shows per-container configuration: image, ports, pull policy, resource limits, environment variables, and volume mounts.

**Metrics** shows CPU and memory sparklines per container, polled every 15 seconds via `metrics.k8s.io`. Requires metrics-server on the cluster.

**Logs** streams or fetches pod logs with per-container selection, severity filtering, and text search. The AI Analyse button gathers logs, pod conditions, and Kubernetes events from all three levels (Deployment, ReplicaSet, Pod) and sends them to Claude for triage. This covers failure modes where no logs exist yet — scheduling failures, image pull errors, resource constraints — because it reads from events rather than relying on application output.

**Revisions** lists ReplicaSet history, most recent first, with a Rollback button per revision.

**Edit** provides live editing of instance count, container images, environment variables, and exposed ports. One Save button patches the Deployment and Service in a single operation.

**Assistant** is a persistent chat panel available on every page. It is context-aware of whatever you are looking at — current page, open service, environment — and can:

- Answer questions about your services in plain English ("is nginx healthy?", "why is my app slow?")
- Proactively fetch logs, events, and pod conditions before answering health questions — it does not ask you to go check yourself
- Translate a Docker Compose file into a Portainer Run deployment and pre-populate the deploy form
- Describe a deployment you want ("deploy wordpress with a mysql sidecar") and pre-populate the form
- Detect scale requests ("scale nginx to 3") and open the Edit tab with the instances field pre-filled
- Route destructive actions (delete, rollback) to the existing UI — the assistant never executes irreversible operations directly

The assistant is scoped to container operations only. It declines unrelated questions. Conversation history is kept for the duration of the session and cleared on disconnect.

## Architecture

```
Browser → Node proxy (server.js) → Portainer API
                                  → Anthropic API (if configured)
```

Portainer Run is a single HTML file served by a small Node.js proxy. The proxy handles three things: it forwards API calls to Portainer (bypassing browser CORS), it relays AI requests to Anthropic (keeping the API key server-side), and it maintains a file-backed session cache keyed by a hash of the user's token.

The user's credentials never appear in server logs. The Anthropic API key never reaches the browser.

The proxy serves HTTPS on port 443 with a self-signed certificate by default. Port 80 redirects to HTTPS. Real certificates can be provided at runtime.

### Session cache

The server maintains a file-backed cache at `data/cache.json` (configurable via `CACHE_DIR`). On reconnect, the last known deployment state is shown immediately while live data loads in the background. The cache is keyed by a SHA-256 hash of the user's token and cleared on disconnect. Mount `CACHE_DIR` as a Docker volume to persist the cache across container restarts.

## Files

`server.js` — Node.js proxy, static file server, and session cache.  
`portainer-run.html` — entire frontend (single file).  
`Dockerfile` — builds from `node:20-alpine` with `openssl` for certificate generation.  
`.env.example` — environment variable reference.

## Deployment

### Build

```bash
DOCKER_BUILDKIT=0 docker build -t portainer-run .
```

### Run (self-signed certificate)

```bash
docker run -d \
  -p 443:443 \
  -p 80:80 \
  -e PORTAINER_URL=https://portainer.example.com:9443 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  --name portainer-run \
  portainer-run
```

On first start the container generates a self-signed TLS certificate (3 year validity). The browser will warn about the certificate on first access — accept the exception to proceed.

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

## Environment variables

`PORTAINER_URL` is required. All others are optional.

| Variable | Default | Description |
|---|---|---|
| `PORTAINER_URL` | — | Full URL of your Portainer instance. Example: `https://portainer.example.com:9443` |
| `ANTHROPIC_API_KEY` | — | Anthropic API key. Required for the Assistant and AI triage features. |
| `PORT` | `443` | HTTPS listen port inside the container. |
| `HTTP_PORT` | `80` | HTTP redirect port inside the container. |
| `SSL_CERT` | — | Path to TLS certificate file. Uses self-signed if not set. |
| `SSL_KEY` | — | Path to TLS private key file. Uses self-signed if not set. |
| `SSL_CERT_DIR` | `/app` | Directory for self-signed certificate storage. |
| `CACHE_DIR` | `/app/data` | Directory for session cache file. Mount as a volume to persist across restarts. |

## Connecting

Navigate to `https://<your-host>` and enter a Portainer personal access token. Generate one in Portainer under Account → Access Tokens. The token scope determines what Portainer Run can see and do — namespace-scoped tokens will require manual namespace entry on deploy; cluster-scoped tokens enumerate namespaces automatically.

The token or JWT obtained on login determines what Portainer Run can see and do — Portainer's RBAC applies in full. Namespace-scoped tokens will require manual namespace entry on deploy; cluster-scoped tokens enumerate namespaces automatically.

Sessions persist across page refreshes and are cleared on disconnect or when the browser tab is closed.

## Assistant

The Assistant requires an `ANTHROPIC_API_KEY` to be configured on the server. Without it the Assistant button is not available.

When answering health or performance questions, the Assistant automatically fetches diagnostic data (logs, pod conditions, Kubernetes events) before generating a response. It does not ask you to check these yourself.

Docker Compose files can be pasted directly into the Assistant input. It will translate the compose file into Portainer Run's deployment model (all services become containers in a single pod sharing localhost), show a preview, and populate the deploy form. Build directives and network aliases are flagged as unmappable.

The Assistant is scoped to container operations only and will decline unrelated questions. Session history is kept in memory only and cleared on disconnect.

## Notes on scope

Portainer Run only surfaces deployments it created. It tags every Deployment, Service, PVC, and Ingress with `managed-by=portainer-run` and filters all views to that label. Workloads deployed through Portainer's own UI or `kubectl` will not appear.

Persistent storage volumes cannot be modified after deployment. PVCs are created at deploy time and are not touched by the Edit tab.

OAuth authentication is not currently supported. Users in OAuth-configured Portainer deployments should generate a personal access token in Portainer under Account → Access Tokens.
