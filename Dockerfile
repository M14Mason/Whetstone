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

# Make every copied file readable by the unprivileged runtime user.
#
# THIS IS WHY THE SITE WENT DOWN ON 10 SEP 2026. Docker COPY preserves the mode
# of each file in the build context. A developer machine with a restrictive
# umask produces 600 files; they land here root-owned and unreadable to `node`,
# and the container dies with
#
#   Error: EACCES: permission denied, open '/app/server.js'
#
# four seconds into every boot. Fly restarts it ten times, gives up, and serves
# 502 to every visitor. Nothing in the application code is wrong, which is what
# makes it so expensive to find.
#
# a+rX, not a+rx: capital X sets the execute bit on directories only, so files
# do not all become executable.
RUN chmod -R a+rX /app && chmod a+rx /app/scripts/docker-start.sh

# Prove it as the user that will actually run the app. A build that produces an
# unreadable image must fail HERE, loudly, in fifteen seconds - not silently in
# production forty minutes later.
RUN su node -c 'test -r /app/server.js \
 && test -r /app/lib/config.js \
 && test -r /app/public/index.html \
 && test -r /app/public/app.js \
 && test -x /app/scripts/docker-start.sh' \
 && echo "verified: the runtime user can read the application"

ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/keen.db \
    BACKUP_DIR=/data/backups

# Drop root. The volume is chowned at deploy time by the platform.
USER node

EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/scripts/docker-start.sh"]
