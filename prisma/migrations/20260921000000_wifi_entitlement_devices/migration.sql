-- Real per-device registration list, replacing reliance on the single
-- WifiEntitlement.deviceMac scalar for anything beyond auto-reconnect
-- caching. Backfills one row per entitlement that already has a remembered
-- device, so existing customers aren't silently reset to 0 registered
-- devices.
CREATE TABLE "WifiEntitlementDevice" (
  "id" TEXT NOT NULL,
  "entitlementId" TEXT NOT NULL,
  "deviceMac" TEXT NOT NULL,
  "label" TEXT,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3),
  CONSTRAINT "WifiEntitlementDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WifiEntitlementDevice_entitlementId_deviceMac_key" ON "WifiEntitlementDevice"("entitlementId", "deviceMac");
CREATE INDEX "WifiEntitlementDevice_entitlementId_idx" ON "WifiEntitlementDevice"("entitlementId");
CREATE INDEX "WifiEntitlementDevice_deviceMac_idx" ON "WifiEntitlementDevice"("deviceMac");

ALTER TABLE "WifiEntitlementDevice" ADD CONSTRAINT "WifiEntitlementDevice_entitlementId_fkey"
  FOREIGN KEY ("entitlementId") REFERENCES "WifiEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "WifiEntitlementDevice" ("id", "entitlementId", "deviceMac", "addedAt")
SELECT gen_random_uuid()::text, "id", "deviceMac", "createdAt"
FROM "WifiEntitlement"
WHERE "deviceMac" IS NOT NULL;
