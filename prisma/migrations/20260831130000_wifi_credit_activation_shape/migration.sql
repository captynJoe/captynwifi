ALTER TABLE "WifiCredit" ADD COLUMN IF NOT EXISTS "deviceMac" TEXT;
ALTER TABLE "WifiCredit" ADD COLUMN IF NOT EXISTS "siteId" TEXT;
ALTER TABLE "WifiCredit" ADD COLUMN IF NOT EXISTS "planId" TEXT;
ALTER TABLE "WifiCredit" ADD COLUMN IF NOT EXISTS "rateLimit" TEXT;
ALTER TABLE "WifiCredit" ADD COLUMN IF NOT EXISTS "deviceLimit" INTEGER;

CREATE INDEX IF NOT EXISTS "WifiCredit_deviceMac_consumedAt_expiresAt_idx" ON "WifiCredit"("deviceMac", "consumedAt", "expiresAt");
