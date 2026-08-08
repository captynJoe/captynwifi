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
