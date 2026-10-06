-- CAPTYN WiFi menu follow-up, 2026-10-06 (Manual pricing mode).
-- Cruise Month was slower than Cruise Weekly; add a 2-day pass between
-- Day Pass (45) and Highspeed Weekend (120). Rates are upload/download.
-- Run once: docker exec -i captyn-wifi-wifi_db-1 psql -U captyn_wifi -d captyn_wifi -v ON_ERROR_STOP=1 < scripts/menu-2026-10-06b.sql

BEGIN;

UPDATE "WifiPlan" SET "rateLimit" = '7M/12M', "updatedAt" = now()
WHERE source = 'captyn_admin' AND name = 'Cruise Month';

-- manualPricing: the menu is on Manual, and only manual (or free) base
-- packages are shown to customers.
INSERT INTO "WifiPlan" (id, "siteId", source, "externalPackageId", name, "durationSeconds", "priceKsh", "rateLimit", "deviceLimit", enabled, "updatedAt", category, featured, "manualPricing")
SELECT gen_random_uuid()::text, "siteId", 'captyn_admin', '2-days-172800s-80kes', '2 Days', 172800, 80, '5M/10M', 1, true, now(), 'standard', false, true
FROM "WifiPlan" WHERE source = 'captyn_admin' AND name = 'Day Pass'
  AND NOT EXISTS (SELECT 1 FROM "WifiPlan" WHERE source = 'captyn_admin' AND name = '2 Days');

SELECT name, "priceKsh" AS ksh, round("durationSeconds" / 3600.0, 1) AS hours, "rateLimit", "deviceLimit" AS devices
FROM "WifiPlan" WHERE source = 'captyn_admin' AND enabled AND "durationSeconds" >= 86400 ORDER BY "priceKsh";

COMMIT;
