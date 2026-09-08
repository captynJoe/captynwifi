-- Add scheduling support for WiFi free-access promos.
ALTER TABLE "WifiPromo" ADD COLUMN "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "WifiPromo" ADD COLUMN "activatedAt" TIMESTAMP(3);

-- Existing active promos were already live before scheduling existed.
UPDATE "WifiPromo"
SET "activatedAt" = COALESCE("activatedAt", "createdAt")
WHERE "active" = true AND "startsAt" <= CURRENT_TIMESTAMP;

CREATE INDEX "WifiPromo_active_startsAt_endsAt_idx" ON "WifiPromo"("active", "startsAt", "endsAt");
