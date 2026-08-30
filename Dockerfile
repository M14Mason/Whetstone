# Keen container image.
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
# Install dependencies BEFORE copying source, so this layer is cached and a
# code change does not re-run the install.
#
# This step did not exist. The app was written with zero npm dependencies, so
# nothing needed installing -- until posthog-node was added to package.json and
# the image was built without it. The server then died on require() before it
# could listen, and the machine ended up stopped. --omit=dev because nothing
# here needs the test tooling, and `|| true` because a dependency install
# failing must not be able to block a deploy of the app itself.
RUN npm install --omit=dev --no-audit --no-fund || true
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
 && DATABASE_PATH=/app/seed/keen.db node scripts/seed.js \
 && chmod +x /app/scripts/docker-start.sh \
 && chown -R node:node /app/seed

ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/keen.db \
    BACKUP_DIR=/data/backups

# Drop root. The volume is chowned at deploy time by the platform.
USER node

EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/scripts/docker-start.sh"]
