#!/bin/sh
# Container entrypoint.
#
# Seeding 26,942 questions into an empty SQLite file takes about 52 seconds.
# On a host with no persistent disk that cost is paid on every cold start, so
# a tester waits nearly two minutes before the page responds and the platform's
# health check may fail the deploy outright.
#
# The fix: seed once at image build time and bake the result into the image.
# At start we copy that prebuilt database to the writable path, which takes
# well under a second. User data still does not survive a restart on an
# ephemeral disk, but that was already true and is documented in render.yaml.

set -e

DB="${DATABASE_PATH:-/tmp/whetstone.db}"
SEED="/app/seed/whetstone.db"

if [ ! -f "$DB" ] && [ -f "$SEED" ]; then
  echo "  Restoring prebuilt question bank to $DB"
  mkdir -p "$(dirname "$DB")"
  cp "$SEED" "$DB"
fi

mkdir -p "${BACKUP_DIR:-/tmp/backups}"

exec node server.js
