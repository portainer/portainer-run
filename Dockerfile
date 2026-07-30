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

CMD ["node", "server/server.js"]
