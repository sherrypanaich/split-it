# Split it in a container. Data lives in a volume at /data.
#   docker compose up -d        (see compose.yaml)
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN rm -rf data test && mkdir -p /data
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data NODE_ENV=production
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/manifest.webmanifest >/dev/null || exit 1
CMD ["node", "server.js"]
