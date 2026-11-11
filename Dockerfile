# Split it in a container. Data lives in a volume at /data.
#   docker compose up -d        (see compose.yaml)
FROM node:24-alpine
WORKDIR /app
COPY . .
# The app runs as the ordinary "node" user, not root, and can only write to /data.
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data NODE_ENV=production
EXPOSE 8080
VOLUME ["/data"]
USER node
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/manifest.webmanifest >/dev/null || exit 1
CMD ["node", "server.js"]
