# Group Dining MVP. No npm dependencies: the image is Node plus our files.
# For reproducible builds, pin the base image by digest once you have chosen one (docker pull, then use @sha256:...).
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/group-dining.sqlite \
    BACKUP_DIR=/data/backups

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server ./server
COPY data/restaurants.template.csv ./data/restaurants.template.csv
COPY scripts/places.mjs scripts/check-config.mjs scripts/smoke.mjs ./scripts/

# The database and backups live on a volume owned by the unprivileged "node" user.
RUN mkdir -p /data/backups && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["node", "server/index.js"]
