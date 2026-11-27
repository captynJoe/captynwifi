-- Vouchers whose hours start on first use, not at issue.
ALTER TABLE "WifiEntitlement" ADD COLUMN "startsOnFirstUseSeconds" INTEGER;
CREATE INDEX "WifiEntitlement_startsOnFirstUseSeconds_idx" ON "WifiEntitlement"("startsOnFirstUseSeconds") WHERE "startsOnFirstUseSeconds" IS NOT NULL;
