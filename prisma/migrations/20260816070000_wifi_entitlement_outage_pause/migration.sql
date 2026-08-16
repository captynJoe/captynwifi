ALTER TABLE "WifiEntitlement" ADD COLUMN IF NOT EXISTS "outagePausedAt" TIMESTAMP(3);
ALTER TABLE "WifiEntitlement" ADD COLUMN IF NOT EXISTS "outagePauseCause" TEXT;
CREATE INDEX IF NOT EXISTS "WifiEntitlement_outagePausedAt_idx" ON "WifiEntitlement" ("outagePausedAt");

ALTER TABLE "WifiOutageCredit" ADD COLUMN IF NOT EXISTS "entitlementId" TEXT;
CREATE INDEX IF NOT EXISTS "WifiOutageCredit_entitlementId_idx" ON "WifiOutageCredit" ("entitlementId");
