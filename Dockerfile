# Whetstone container image.
#
# Node 22 is required for the built-in node:sqlite module. Alpine keeps the
# image small; the app has zero npm dependencies so there is nothing to install.

FROM node:22-alpine

# Signal handling: without an init process, SIGTERM does not reach Node and the
# graceful shutdown in server.js never runs, so deploys cut off live requests.
RUN apk add --no-cache tini

WORKDIR /app

# Copy only what the server needs at runtime.
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY data ./data
COPY scripts ./scripts

# The database lives on a mounted volume, not in the image layer, so it
# survives deploys. DATABASE_PATH points at the mount.
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/whetstone.db \
    BACKUP_DIR=/data/backups

# Drop root. The volume is chowned at deploy time by the platform.
USER node

EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
