FROM node:20-alpine

# Install openssl for self-signed cert generation
RUN apk add --no-cache openssl

WORKDIR /app

COPY server.js .
COPY portainer-run.html .

# Expose HTTPS and HTTP redirect ports
EXPOSE 443
EXPOSE 80

CMD ["node", "server.js"]
