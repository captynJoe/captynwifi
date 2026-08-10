ALTER TABLE "WifiPlan" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'standard';

UPDATE "WifiPlan"
SET "category" = 'limited'
WHERE "priceKsh" = 0;

CREATE INDEX "WifiPlan_siteId_category_enabled_idx" ON "WifiPlan"("siteId", "category", "enabled");
