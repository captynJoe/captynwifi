# CAPTYN Wi-Fi

Dedicated CAPTYN Wi-Fi control-plane service.

This service is a sibling to CAPTYN Housing, not a replacement for it. Housing owns resident/building UX and can call this service when a Wi-Fi package payment is confirmed. CAPTYN Wi-Fi owns entitlements, RADIUS projection records, accounting sessions, and future MikroTik/FreeRADIUS control-plane work.

## Current endpoints

- `GET /health`
- `POST /api/integrations/housing/packages/sync`
- `POST /api/integrations/housing/payments/confirmed`

Integration requests must include `x-captyn-wifi-token: <CAPTYN_WIFI_INTEGRATION_TOKEN>`.

## Validate

```bash
npm install
npm run typecheck
env DATABASE_URL=postgresql://captyn_wifi:captyn_wifi@localhost:5432/captyn_wifi npx prisma validate --schema prisma/schema.prisma
npm run build
```

## RADIUS SQL Projection

`npm run radius:worker` applies pending `WifiRadiusProjection` rows into FreeRADIUS-compatible `radcheck` and `radreply` tables in the WiFi database. FreeRADIUS can then use the WiFi database as its SQL authorization source while CAPTYN WiFi remains the business source of truth.

Set `CAPTYN_WIFI_RADIUS_SQL_ENABLED=false` to disable the worker. The Docker Compose stack includes `radius_worker` for continuous projection.

## FreeRADIUS

The Docker Compose stack includes a `freeradius` service bound to the private/WireGuard address in `CAPTYN_WIFI_RADIUS_BIND_IP` on UDP `1812` and `1813`.

MikroTik should use that private address as its RADIUS server and the shared secret from `CAPTYN_WIFI_RADIUS_SECRET`. Do not expose these UDP ports publicly.

MikroTik pointing commands are documented in `docs/mikrotik-radius-pointing.md`.

## Dynamic Governor

`npm run governor:worker` runs the CAPTYN WiFi dynamic governor loop. The first rollout is intentionally conservative: it reads active FreeRADIUS accounting rows, estimates current demand from octet deltas, applies GREEN/YELLOW/RED/CRITICAL hysteresis, and records `WifiGovernorEvent` rows for review.

Defaults are safe: `CAPTYN_WIFI_GOVERNOR_ENABLED=false` in code and the Compose `wifi_governor` service runs only under the `governor` profile with `CAPTYN_WIFI_GOVERNOR_DRY_RUN=true`. In dry-run mode it does not rewrite RADIUS rows and does not kick active users.

Useful env flags:

- `CAPTYN_WIFI_GOVERNOR_ENABLED=true` enables the worker.
- `CAPTYN_WIFI_GOVERNOR_DRY_RUN=true` keeps it observational.
- `CAPTYN_WIFI_GOVERNOR_WAN_DOWNLOAD_MBPS=140` sets the downstream capacity assumption.
- `CAPTYN_WIFI_GOVERNOR_WAN_UPLOAD_MBPS=40` sets the upstream capacity assumption.
- `CAPTYN_WIFI_GOVERNOR_APPLY_RADIUS_SQL=true` lets the worker rewrite `Mikrotik-Rate-Limit` in `radreply` for future authorizations.
- `CAPTYN_WIFI_GOVERNOR_KICK_ON_CHANGE=true` forces active sessions to reconnect after a changed rate. Leave this off until the dry-run data looks sane.

Start locally/on the WiFi host with:

```bash
docker compose --profile governor up -d wifi_governor
```

For a later VPS4 move, the worker needs either private DB access to the WiFi database or equivalent API endpoints for active accounting and rate-application decisions.
