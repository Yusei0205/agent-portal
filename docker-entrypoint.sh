#!/bin/sh
# docker-entrypoint.sh
#
# Ensures the volume-backed tool directories exist, then either runs the
# default portal server (when no arguments are supplied) or executes the
# given command verbatim.
#
# Examples:
#   docker run agent-portal                           → starts the portal
#   docker run agent-portal node dist/preflight.mjs   → runs preflight
#   docker run agent-portal sh                        → opens a shell
set -e

# Create the persistent tool directories on every start.
# These live on the data volume, so a fresh volume will be empty.
mkdir -p /data/home/.local/bin /data/tools/bin

# If no arguments were passed, start the portal (default behaviour).
if [ "$#" -eq 0 ]; then
  exec node --disable-warning=ExperimentalWarning dist/server.mjs
fi

# Otherwise run whatever was supplied.
exec "$@"
