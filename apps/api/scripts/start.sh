#!/bin/sh
# Render's start command. It is a script because Render does not honor quotes in `dockerCommand`:
# `/bin/sh -c "..."` is run as one program name and fails with exit 127.
#
# set -e stops the start when the migration fails, so the server never runs against a
# half-migrated schema. exec hands PID 1 to bun, so Render's SIGTERM reaches the shutdown drain
# instead of stopping at the shell.
set -e

bun scripts/migrate.ts
exec bun src/main.ts
