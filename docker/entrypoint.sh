#!/bin/sh
set -e

# Ensure data dir exists and is owned by hna, even if the user mounted a
# pre-existing volume owned by a different UID (e.g., an older image or a
# root-owned host bind mount).
mkdir -p /data /data/logos
chown -R hna:hna /data

# Drop to the hna user and exec the passed command
exec gosu hna:hna "$@"
