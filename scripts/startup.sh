#!/usr/bin/env bash
# Startup command for Azure App Service.
#
# The app itself is plain Node. This wrapper exists for one reason: certificate
# PDFs are rendered by headless Chromium, and the Linux App Service image ships
# neither a browser nor the shared libraries Chrome needs. The deploy workflow
# installs the browser binary into .cache/puppeteer; this script installs the
# libraries, which must happen on the machine that actually runs the app.
#
# Every step is best-effort: if the libraries cannot be installed the app still
# starts, and the Certificates page reports that PDF rendering is unavailable
# rather than the whole site failing to boot.

set -u

CACHE_DIR="${PUPPETEER_CACHE_DIR:-$(pwd)/.cache/puppeteer}"
export PUPPETEER_CACHE_DIR="$CACHE_DIR"

# Chrome needs these at runtime. apt-get is only available on the Debian-based
# images; on anything else this is skipped and CHROME_PATH can be set instead.
if command -v apt-get >/dev/null 2>&1; then
  MISSING=""
  for lib in libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
             libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
             libgbm1 libpango-1.0-0 libcairo2 libasound2; do
    dpkg -s "$lib" >/dev/null 2>&1 || MISSING="$MISSING $lib"
  done

  if [ -n "$MISSING" ]; then
    echo "[startup] installing Chromium runtime libraries:$MISSING"
    # The image runs as wwwroot by default; apt needs root.
    SUDO=""
    [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
    $SUDO apt-get update -qq >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    $SUDO apt-get install -y -qq --no-install-recommends $MISSING >/dev/null 2>&1 \
      || echo "[startup] could not install some libraries - PDF rendering may be unavailable"
  else
    echo "[startup] Chromium runtime libraries already present"
  fi
else
  echo "[startup] apt-get not available - skipping Chromium library install"
fi

echo "[startup] starting the API"
exec node dist/server.js
