#!/usr/bin/env bash
# Deploys CAPTYN WiFi on this host, step by step, with almost no downtime.
#
#   1. Type checks and tests run inside the live API container; any failure
#      stops here and nothing changes.
#   2. The new code is compiled inside the running API container while the old
#      version keeps serving customers.
#   3. Only then are wifi_api and radius_worker restarted. Their start script
#      sees the build is current and skips straight to running (seconds).
#   4. Waits until the API answers healthy and the worker is running, then
#      restarts the payment worker on the finished code.
#
# Usage: scripts/deploy.sh            (from anywhere)
#        scripts/deploy.sh --skip-tests
set -euo pipefail
cd "$(dirname "$0")/.."

API=captyn-wifi-wifi_api-1
WORKER=captyn-wifi-radius_worker-1
PAYMENTS=captyn-wifi-payment_activation_worker-1
start_time=$(date +%s)
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31mDEPLOY STOPPED:\033[0m %s\n' "$*" >&2; exit 1; }
elapsed() { echo "$(( $(date +%s) - start_time ))s"; }
in_api() { docker exec -w /app "$API" sh -c "$1"; }

step "Deploying $(git log --oneline -1)"
dirty=$(git status --short -- src prisma public ':!public/portal-build' | wc -l)
[ "$dirty" -gt 0 ] && echo "    note: $dirty uncommitted file(s) will be deployed as they are on disk"
docker inspect -f '{{.State.Running}}' "$API" 2>/dev/null | grep -q true || fail "$API isn't running; start it with: docker compose up -d wifi_api"

if [ "${1:-}" != "--skip-tests" ]; then
  step "Type checks and tests (old version keeps serving)"
  in_api "npm run prisma:generate >/dev/null && npm run typecheck >/tmp/deploy-typecheck.log 2>&1" \
    || { docker exec "$API" tail -30 /tmp/deploy-typecheck.log; fail "type check failed"; }
  ok "type check"
  in_api "npm test >/tmp/deploy-tests.log 2>&1" \
    || { docker exec "$API" sh -c 'grep -E "^not ok|# fail" -A8 /tmp/deploy-tests.log | head -40'; fail "tests failed"; }
  ok "tests: $(docker exec "$API" sh -c 'grep -E "^# pass" /tmp/deploy-tests.log | head -1')"
fi

step "Compiling the new version (old version keeps serving)"
in_api 'npm run build >/tmp/deploy-build.log 2>&1 && find src prisma/schema.prisma tsconfig.json tsconfig.portal.json package-lock.json -type f | sort | xargs sha256sum | sha256sum | cut -c1-64 > dist/.captyn-src-hash' \
  || { docker exec "$API" tail -30 /tmp/deploy-build.log; fail "build failed; the running version is untouched"; }
ok "compiled ($(elapsed))"

# Installs from before container-start.sh existed have no "installed from
# this lockfile" marker; if the container installed after the lockfile last
# changed, mark it so the restart doesn't reinstall for nothing.
lock_hash=$(sha256sum package-lock.json | cut -c1-64)
lock_mtime=$(stat -c %Y package-lock.json)
for c in "$API" "$WORKER" captyn-wifi-wifi_governor-1; do
  docker inspect "$c" >/dev/null 2>&1 || continue
  started=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$c")" +%s)
  if [ "$started" -gt "$lock_mtime" ]; then
    docker exec "$c" sh -c "[ -f node_modules/.captyn-lock-hash ] || echo $lock_hash > node_modules/.captyn-lock-hash" || true
  fi
done

step "Restarting wifi_api and radius_worker"
restart_at=$(date +%s)
docker compose up -d --force-recreate wifi_api radius_worker >/dev/null 2>&1
ok "restarted"

step "Waiting for the API to answer"
for _ in $(seq 1 150); do
  if docker exec "$API" wget -q -T 3 -O /dev/null http://localhost:4120/health 2>/dev/null; then break; fi
  sleep 2
done
docker exec "$API" wget -q -T 3 -O /dev/null http://localhost:4120/health 2>/dev/null \
  || { docker logs --tail 40 "$API"; fail "API didn't come up within 5 minutes (logs above)"; }
ok "API healthy after $(( $(date +%s) - restart_at ))s offline"
migrations=$(docker logs --since "$(date -u -d @"$restart_at" +%Y-%m-%dT%H:%M:%S)" "$API" 2>&1 | grep -oE "Applying migration \`[^\`]+\`" | sed 's/Applying migration //' || true)
[ -n "$migrations" ] && echo "$migrations" | sed 's/^/    migration applied: /'

step "Waiting for the RADIUS worker"
for _ in $(seq 1 120); do
  docker logs --since "$(date -u -d @"$restart_at" +%Y-%m-%dT%H:%M:%S)" "$WORKER" 2>&1 | grep -q "worker running" && break
  sleep 2
done
docker logs --since "$(date -u -d @"$restart_at" +%Y-%m-%dT%H:%M:%S)" "$WORKER" 2>&1 | grep -q "worker running" \
  || { docker logs --tail 30 "$WORKER"; fail "RADIUS worker didn't start (logs above); the API is up"; }
ok "RADIUS worker running"

step "Restarting the payment worker on the finished code"
pay_at=$(date +%s)
docker compose restart payment_activation_worker >/dev/null 2>&1
# Node starts slowly right after a deploy (the API and worker are warming up
# on a small CPU share): give it 3 minutes, not 1.
for _ in $(seq 1 90); do
  docker logs --since "$(date -u -d @"$pay_at" +%Y-%m-%dT%H:%M:%S)" "$PAYMENTS" 2>&1 | grep -q "worker started" && break
  sleep 2
done
docker logs --since "$(date -u -d @"$pay_at" +%Y-%m-%dT%H:%M:%S)" "$PAYMENTS" 2>&1 | grep -q "worker started" \
  || { docker logs --tail 30 "$PAYMENTS"; fail "payment worker didn't start (logs above)"; }
ok "payment worker running"

step "Checking from outside"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://captyn.shop/wifi/ || echo "---")
[ "$code" = "200" ] && ok "captyn.shop/wifi answers 200" || echo "    ! captyn.shop/wifi answered $code"

printf '\n\033[32mDeployed\033[0m %s in %s\n' "$(git log --oneline -1)" "$(elapsed)"
