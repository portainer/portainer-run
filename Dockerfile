# Build the Vite client
FROM oven/bun:1 AS build-ui
WORKDIR /build
COPY client/package.json client/bun.lock ./
RUN bun install --frozen-lockfile
COPY client/ ./
RUN bun run build

FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=build-ui /build/dist ./client/dist
COPY server/ ./server/

EXPOSE 443
EXPOSE 80

ENV NODE_ENV=production

CMD ["node", "server/server.js"]
