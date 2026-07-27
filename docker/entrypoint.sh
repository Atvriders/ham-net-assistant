#!/bin/sh
set -e

# Ensure data dir exists and is owned by hna, even if the user mounted a
# pre-existing volume owned by a different UID (e.g., an older image or a
# root-owned host bind mount). /data/backups sits inside the same volume on
# purpose — a snapshot written anywhere else would vanish with the container
# that wrote it.
mkdir -p /data /data/logos /data/backups
chown -R hna:hna /data

# --- pre-migration snapshot ------------------------------------------------
# The CMD runs `prisma migrate deploy` unattended on every boot, against the
# club's only copy of years of FCC-facing net logs. Take a WAL-safe snapshot
# first (VACUUM INTO through the Prisma client — this image deliberately has no
# sqlite3 CLI) so a bad migration, or an image that `pull_policy: always`
# fetched and nobody reviewed, is recoverable instead of terminal.
#
# Deliberately NOT fatal: a club whose disk filled up still needs its net to
# come up tonight, and a container stuck in a restart loop over a backup would
# be a self-inflicted outage. Failures are shouted into the log instead — and
# they appear BEFORE any migration has touched the database.
SNAPSHOT_JS=/app/apps/api/dist/cli/backup.js
if [ -n "${HNA_SKIP_PRE_MIGRATE_BACKUP:-}" ]; then
  echo "[entrypoint] HNA_SKIP_PRE_MIGRATE_BACKUP set - skipping pre-migration snapshot"
elif [ ! -f "$SNAPSHOT_JS" ]; then
  echo "[entrypoint] WARNING: $SNAPSHOT_JS missing - booting WITHOUT a pre-migration snapshot" >&2
else
  # Run it as hna so the snapshot ends up owned by the app user, like the
  # database it was taken from.
  if ! gosu hna:hna node "$SNAPSHOT_JS"; then
    echo "[entrypoint] WARNING: pre-migration snapshot failed - continuing boot" >&2
  fi
fi

# Drop to the hna user and exec the passed command
exec gosu hna:hna "$@"
