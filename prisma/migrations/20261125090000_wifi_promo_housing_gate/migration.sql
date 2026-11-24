-- Tenants-only promos: only tenants of this CAPTYN Housing building with
-- nothing overdue can claim.
ALTER TABLE "WifiPromo" ADD COLUMN "housingBuildingId" TEXT;
