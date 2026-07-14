# Stage 1: Build the Vite client
FROM oven/bun:1 AS build-ui
WORKDIR /build
COPY client/package.json ./
RUN bun install
COPY client/ ./
RUN bun run build

# Stage 2: Install server dependencies
# bun:sqlite is built into Bun — no native build tools needed
FROM oven/bun:1 AS build-server
WORKDIR /deps
COPY server/package.json ./
RUN bun install --production

# Stage 3: Slim runtime image
FROM oven/bun:1 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Client build artifacts
COPY --from=build-ui /build/dist ./client/dist

# Server source
COPY server/ ./server/

# Server node_modules (js-yaml only)
COPY --from=build-server /deps/node_modules ./server/node_modules

# Ensure data directory exists for SQLite db and cache
# Mount as a volume in production to persist across restarts:
#   -v portainer-run-data:/app/data
RUN mkdir -p /app/data

EXPOSE 443
EXPOSE 80

ENV NODE_ENV=production

# Release version, supplied by the release workflow (--build-arg PORTAINER_RUN_VERSION=...).
# Defaults to 'dev' for local and PR builds.
ARG PORTAINER_RUN_VERSION=dev
ENV PORTAINER_RUN_VERSION=$PORTAINER_RUN_VERSION

CMD ["bun", "run", "server/server.js"]
