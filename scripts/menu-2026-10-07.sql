-- CAPTYN WiFi menu, 2026-10-07 (Manual pricing; needs the
-- 20261007200000_wifi_device_selector migration for "maxDevices").
-- Run once: docker exec -i captyn-wifi-wifi_db-1 psql -U captyn_wifi -d captyn_wifi -v ON_ERROR_STOP=1 < scripts/menu-2026-10-07.sql

BEGIN;

-- Cruise Month x2 devices (KSh 688) undercut by Monthly 2 Devices (KSh 500):
-- Cruise Month stays 1 device; Monthly 2 Devices is the 2-device monthly.
UPDATE "WifiPlan" SET "maxDevices" = 1, "updatedAt" = now()
WHERE source = 'captyn_admin' AND name = 'Cruise Month';

-- "12 HR" ran 8 hours. 12 hours, 1 device to start (the picker sells a
-- second at x1.6), so it no longer undercuts 9 Balls' 2-device price.
UPDATE "WifiPlan" SET "durationSeconds" = 43200, "deviceLimit" = 1, "maxDevices" = 3, "updatedAt" = now()
WHERE source = 'captyn_admin' AND name = '12 HR';

-- Fast lane: three Turbo packages at 20 Mbps (capped there -- the line is
-- 80 Mbps for everyone), ~2x the price of the matching everyday package
-- for 2.5x its speed. Reuses three unpublished packages with no sales.
UPDATE "WifiPlan" SET name = 'Turbo Hour', "durationSeconds" = 3600, "priceKsh" = 12, "rateLimit" = '8M/20M',
  "deviceLimit" = 1, "maxDevices" = 3, "manualPricing" = true, enabled = true, "updatedAt" = now()
WHERE source = 'captyn_admin' AND name = 'Speed Hour';
UPDATE "WifiPlan" SET name = 'Turbo 3 HR', "durationSeconds" = 10800, "priceKsh" = 25, "rateLimit" = '8M/20M',
  "deviceLimit" = 1, "maxDevices" = 3, "manualPricing" = true, enabled = true, "updatedAt" = now()
WHERE source = 'captyn_admin' AND name = 'Power Burst';
UPDATE "WifiPlan" SET name = 'Turbo Day', "durationSeconds" = 86400, "priceKsh" = 90, "rateLimit" = '8M/20M',
  "deviceLimit" = 1, "maxDevices" = 3, "manualPricing" = true, enabled = true, "updatedAt" = now()
WHERE source = 'captyn_admin' AND name = 'Highspeed 24HR';

SELECT name, "priceKsh" AS ksh, round("durationSeconds" / 3600.0, 1) AS hours, "rateLimit", "deviceLimit" AS devices, "maxDevices" AS max
FROM "WifiPlan" WHERE source = 'captyn_admin' AND enabled AND "priceKsh" > 0 ORDER BY "priceKsh", "durationSeconds";

COMMIT;
