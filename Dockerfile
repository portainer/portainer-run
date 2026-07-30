# Stage 1: Build the Vite client
FROM node:24-alpine AS build-ui
WORKDIR /build
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Install server dependencies
# node:sqlite is built into Node — no native build tools needed
FROM node:24-alpine AS build-server
WORKDIR /deps
COPY server/package.json ./
RUN npm install --omit=dev

# Stage 3: Slim runtime image
FROM node:24-alpine AS runtime

# Not needed at runtime (only used to install deps during the build stages) — strip them to
# shrink the image and reduce CVE surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

RUN apk add --no-cache openssl
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

# Build metadata, supplied by CI (--build-arg GIT_COMMIT=... BUILD_DATE=...).
ARG GIT_COMMIT=unspecified
ARG BUILD_DATE=unspecified
LABEL git_commit=$GIT_COMMIT \
  org.opencontainers.image.revision=$GIT_COMMIT \
  org.opencontainers.image.created=$BUILD_DATE \
  org.opencontainers.image.version=$PORTAINER_RUN_VERSION \
  org.opencontainers.image.title="Portainer Run" \
  org.opencontainers.image.description="Portainer Run - a self-service deployment portal for Kubernetes, backed by the Portainer API." \
  org.opencontainers.image.vendor="Portainer.io" \
  org.opencontainers.image.url="https://www.portainer.io" \
  org.opencontainers.image.documentation="https://docs.portainer.io" \
  io.portainer.portainer-run="true"

CMD ["node", "server/server.js"]
