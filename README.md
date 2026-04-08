# Portainer Run

A Google Cloud Run-style interface for Kubernetes, backed by the Portainer API.

## Why this exists

Portainer is an operator control plane. It is built for the people who manage infrastructure, not for the developers who deploy applications to it. That distinction matters in practice: a developer who needs to ship a container, check its logs, or roll back a bad image does not need the full surface area of Portainer's UI. They need something that gets out of their way.

Portainer Run is that interface. It presents a service-centric view of your Kubernetes environments... deploy a container, see it running, stream its logs, inspect its revisions, and roll back if needed. The underlying platform is still Portainer, with all the RBAC and access controls that implies. Portainer Run just removes the distance between the developer and the outcome.

It is intentionally narrow in scope. It does not replace Portainer. It surfaces a specific workflow (deploy and operate a containerised workload) in the simplest UI we could build for it.

## What it does

Portainer Run connects to your Portainer instance using a personal access token. Access is governed entirely by that token's RBAC permissions, so developers only see and can interact with what Portainer's policies allow.

Once connected, it provides a unified view across all environments the token can reach.

**Dashboard** shows a live health summary across all Kubernetes environments: total services, running, degraded, and unavailable counts, with a per-environment breakdown. The cache refreshes every 60 seconds automatically and after any deploy or delete action.

**Services** lists all deployments tagged with `managed-by=portainer-run`, showing name, image, environment, status, exposure (NodePort, LoadBalancer, or Ingress), and age at a glance.

**Deploy** provides a Cloud Run-style deployment form covering single-container and multi-container (sidecar) workloads, persistent storage (RWO via PVC), environment variables, resource limits, and service exposure (NodePort, LoadBalancer, Ingress). All deployments are tagged `managed-by=portainer-run` so Portainer Run only ever surfaces what it created.

Clicking any service opens a detail panel with six tabs.

**Overview** shows live status (ready/updated/available instances), configuration, labels, and full exposure detail (port chain, external IP, Ingress hostname and path).

**Containers** shows per-container configuration: image, ports, pull policy, resource limits, environment variables, and volume mounts.

**Metrics** shows CPU and memory sparklines per container, polled every 15 seconds via `metrics.k8s.io`. Requires metrics-server to be installed on the cluster.

**Logs** streams or fetches pod logs with per-container selection, severity filtering, and text search. If an Anthropic API key is configured on the server, an AI Analyse button fetches logs from all instances and containers in parallel and sends them to Claude for triage.

**Revisions** lists ReplicaSet history for the deployment, most recent first, with a Rollback button against each revision.

**Edit** provides a full live edit of the deployment: instance count, container images, environment variables per container, and exposed service ports. One Save button patches the Deployment and Service in a single operation.

## Architecture

Portainer Run is a single HTML file served by a small Node.js proxy. The proxy has two jobs: it forwards Kubernetes API calls to Portainer (bypassing browser CORS restrictions) and it relays AI triage requests to the Anthropic API (keeping the API key server-side). The user's Portainer token never touches the server's environment and is never logged.

```
Browser → Node proxy → Portainer API
                     → Anthropic API (if configured)
```

The proxy serves HTTPS on port 443 with a self-signed certificate by default. Port 80 redirects to HTTPS. Real certificates can be mounted in at runtime.

## Files

`server.js` is the Node.js proxy and static file server. `portainer-run.html` is the entire frontend. `Dockerfile` builds a container image from `node:20-alpine` with `openssl` added for certificate generation.

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

On first start the container generates a self-signed TLS certificate (3 year validity) and writes it to `/certs` inside the container. The browser will warn about the certificate on first access; accept the exception to proceed.

### Run (real certificates)

Mount a directory containing your certificate and key files and point the `SSL_CERT` and `SSL_KEY` environment variables at them.

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

If the container cannot resolve your Portainer hostname (error: `EAI_AGAIN`), add `--dns 8.8.8.8` to the run command to override Docker's internal resolver.

## Environment variables

`PORTAINER_URL` is required. All others are optional.

`PORTAINER_URL` — full URL of your Portainer instance including protocol and port. Example: `https://portainer.example.com:9443`.

`ANTHROPIC_API_KEY` — Anthropic API key for AI log triage. If not set, the Analyse with AI button does not appear.

`PORT` — HTTPS listen port inside the container. Default: `443`.

`HTTP_PORT` — HTTP redirect port inside the container. Default: `80`.

`SSL_CERT` — path to TLS certificate file. Default: `/certs/server.crt`.

`SSL_KEY` — path to TLS private key file. Default: `/certs/server.key`.

## Connecting

Navigate to `https://<your-host>` and enter a Portainer personal access token. Generate one in Portainer under Account → Access Tokens. The token scope determines what Portainer Run can see and do: namespace-scoped tokens will prompt for a manual namespace entry on deploy; cluster-scoped tokens enumerate namespaces automatically.

## Notes on scope

Portainer Run only surfaces deployments it created. It tags every Deployment, Service, PVC, and Ingress it creates with `managed-by=portainer-run` and filters the services list to that label. Workloads deployed through Portainer's own UI or via `kubectl` will not appear.

Persistent storage cannot be edited after deployment. PVCs are created per-container at deploy time and are not modified by the Edit tab.

The AI triage feature requires credits on the Anthropic account associated with the API key. It is purely optional; the rest of the application functions without it.
