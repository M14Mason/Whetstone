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
# The Terms and Privacy Policy are served by /api/legal at runtime. Leaving this
# out is why that endpoint returned 404 on every deployment while working
# perfectly in local development, where the files are simply present on disk.
COPY legal ./legal

# The database lives on a mounted volume, not in the image layer, so it
# survives deploys. DATABASE_PATH points at the mount.
COPY scripts/docker-start.sh /app/scripts/docker-start.sh

# Seed the question bank at BUILD time. Doing this at boot costs ~52 seconds
# because the bank is now 26,942 questions, which is long enough to fail a
# platform health check and long enough that a tester assumes the app is dead.
RUN mkdir -p /app/seed \
 && DATABASE_PATH=/app/seed/whetstone.db node scripts/seed.js \
 && chmod +x /app/scripts/docker-start.sh \
 && chown -R node:node /app/seed

ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/whetstone.db \
    BACKUP_DIR=/data/backups

# Drop root. The volume is chowned at deploy time by the platform.
USER node

EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/scripts/docker-start.sh"]
