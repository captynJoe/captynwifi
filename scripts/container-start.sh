#!/bin/sh
# How each CAPTYN WiFi node container starts (see docker-compose.yml).
#
#   container-start.sh <npm-script> build   -- wifi_api: migrate, build if needed, run
#   container-start.sh <npm-script> wait    -- workers: wait for wifi_api's build, run
#
# Packages are reinstalled only when package-lock.json changed, and the code
# is compiled only when the source changed, so a restart after
# scripts/deploy.sh (which builds first, while the old version serves) takes
# seconds instead of minutes of 502s. Only wifi_api builds: the workers used
# to compile into the same shared dist/ at the same time.
set -e
cd /app
script="$1"
mode="${2:-build}"

lock_hash=$(sha256sum package-lock.json | cut -c1-64)
if [ "$(cat node_modules/.captyn-lock-hash 2>/dev/null)" != "$lock_hash" ]; then
  echo "[start] dependencies changed: npm ci"
  npm ci --include=dev
  echo "$lock_hash" > node_modules/.captyn-lock-hash
fi
npm run prisma:generate >/dev/null

src_hash() {
  find src prisma/schema.prisma tsconfig.json tsconfig.portal.json package-lock.json -type f | sort | xargs sha256sum | sha256sum | cut -c1-64
}

if [ "$mode" = "build" ]; then
  npm run prisma:deploy
  want=$(src_hash)
  if [ "$(cat dist/.captyn-src-hash 2>/dev/null)" != "$want" ] || [ ! -f public/portal-build/main.js ]; then
    echo "[start] source changed: building"
    npm run build
    echo "$want" > dist/.captyn-src-hash
  else
    echo "[start] build is current: skipping"
  fi
else
  want=$(src_hash)
  waited=0
  until [ "$(cat dist/.captyn-src-hash 2>/dev/null)" = "$want" ]; do
    if [ "$waited" -ge 600 ]; then
      echo "[start] wifi_api's build never matched the source after 10 min; starting on what's there"
      break
    fi
    [ "$waited" -eq 0 ] && echo "[start] waiting for wifi_api to finish building"
    sleep 5
    waited=$((waited + 5))
  done
fi

echo "[start] running $script"
exec npm run "$script"
