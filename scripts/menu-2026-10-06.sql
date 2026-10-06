-- CAPTYN WiFi menu reset, 2026-10-06.
-- Based on 1,573 paid M-PESA purchases (Aug 1 - Oct 6) and the competitor's
-- flat 10 Mbps menu (3h 10 / 6h 20 / 12h 30 / 24h 50 / week 200 / month 450).
-- Edits base (captyn_admin) packages; live captyn_dynamic copies follow at
-- the next hourly rotation (:55). Rates are MikroTik upload/download.
-- Run once: docker exec -i captyn-wifi-wifi_db-1 psql -U captyn_wifi -d captyn_wifi -v ON_ERROR_STOP=1 < scripts/menu-2026-10-06.sql

BEGIN;

-- Match the competitor on the two best sellers' price points.
UPDATE "WifiPlan" SET "priceKsh" = 10, "rateLimit" = '3M/6M', "updatedAt" = now() WHERE source = 'captyn_admin' AND name = '3 HR Go';
UPDATE "WifiPlan" SET "priceKsh" = 20, "rateLimit" = '3M/6M', "updatedAt" = now() WHERE source = 'captyn_admin' AND name = '6 HR Go';
UPDATE "WifiPlan" SET "rateLimit" = '2M/6M', "updatedAt" = now() WHERE source = 'captyn_admin' AND name = 'Basic Hour';
UPDATE "WifiPlan" SET "rateLimit" = '7M/12M', "updatedAt" = now() WHERE source = 'captyn_admin' AND name = '3 HR cruise';
-- Competitor sells 12h for 30; 8 Balls stays at 30 but runs 10h.
UPDATE "WifiPlan" SET "durationSeconds" = 36000, "updatedAt" = now() WHERE source = 'captyn_admin' AND name = '8 Balls';
-- Daily users spend ~KSh 150/week; competitor week is 200.
UPDATE "WifiPlan" SET "priceKsh" = 180, "deviceLimit" = 1, "updatedAt" = now() WHERE source = 'captyn_admin' AND name = 'Cruise Weekly';
-- Competitor month is 450 at 10 Mbps.
UPDATE "WifiPlan" SET "priceKsh" = 430, "deviceLimit" = 1, "rateLimit" = '5M/10M', "updatedAt" = now() WHERE source = 'captyn_admin' AND name = 'Cruise Month';

-- New: 24h day pass, under the competitor's 50.
INSERT INTO "WifiPlan" (id, "siteId", source, "externalPackageId", name, "durationSeconds", "priceKsh", "rateLimit", "deviceLimit", enabled, "updatedAt", category, featured, "manualPricing")
SELECT gen_random_uuid()::text, "siteId", 'captyn_admin', 'day-pass-86400s-45kes', 'Day Pass', 86400, 45, '5M/10M', 1, true, now(), 'standard', false, false
FROM "WifiPlan" WHERE source = 'captyn_admin' AND name = '3 HR Go'
  AND NOT EXISTS (SELECT 1 FROM "WifiPlan" WHERE source = 'captyn_admin' AND name = 'Day Pass');

-- Unpublish packages that never or almost never sell (kept, not deleted:
-- some have purchase history).
WITH retired AS (
  UPDATE "WifiPlan" SET enabled = false, "updatedAt" = now()
  WHERE source = 'captyn_admin' AND name IN (
    'Gulfstream Week', 'Monthly Standard', 'Highspeed Monthly', 'Cruise 24H', 'Basic Day',
    'Highspeed 24HR', 'Double Device 12 HR', 'Highspeed 6 HR', 'Cruise Quater Day', '12 HR Standard'
  )
  RETURNING id
)
UPDATE "WifiPlan" m SET enabled = false, "updatedAt" = now()
FROM retired WHERE m.source = 'captyn_dynamic' AND m."externalPackageId" = retired.id;

-- Expect 15 published base packages (incl. CAPTYN Welcome, EPL HD 2 HR, Gulfstream 3 HR).
SELECT name, "priceKsh" AS ksh, round("durationSeconds" / 3600.0, 1) AS hours, "rateLimit", "deviceLimit" AS devices
FROM "WifiPlan" WHERE source = 'captyn_admin' AND enabled ORDER BY "priceKsh", "durationSeconds";

COMMIT;
