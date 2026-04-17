FROM node:20-alpine

# openssl for self-signed cert generation; libcap for setcap (so the non-root
# node user can bind low ports 443/80).
RUN apk add --no-cache openssl libcap \
 && setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which node)")"

WORKDIR /app

# Copy application files and pre-create the cache directory. Use the built-in
# 'node' user (uid 1000, already present in node:*-alpine images).
COPY --chown=node:node server.js portainer-run.html ./
RUN mkdir -p /app/data && chown -R node:node /app

USER node

# Expose HTTPS and HTTP redirect ports
EXPOSE 443
EXPOSE 80

CMD ["node", "server.js"]
