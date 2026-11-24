#!/usr/bin/env bash
# Startup command for Azure App Service.
#
# This wrapper exists so the App Service startup command can simply be
# `startup.sh` regardless of which workflow deployed the app:
#
#   - The hand-written workflow (deploy-projelmt.yml) assembles a package whose
#     root already contains the real script, so this file is overwritten there.
#   - Azure's generated workflow (main_projelmt(staging).yml) uploads the repo
#     as-is, so the real script is at scripts/startup.sh. This shim forwards to
#     it.
#
# Keep this file tiny: it is only a locator.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$HERE/scripts/startup.sh" ]; then
  exec bash "$HERE/scripts/startup.sh" "$@"
fi

# No scripts/ directory: this is already the assembled package, but the real
# script went missing. Start the app directly rather than failing the boot.
echo "[startup] scripts/startup.sh not found - starting the API directly"
cd "$HERE" || exit 1
exec node dist/server.js
