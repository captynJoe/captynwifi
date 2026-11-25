-- Tenants-only promos: one device per house, chosen by the tenant.
CREATE TABLE "WifiPromoHouseGrant" (
    "id" TEXT NOT NULL,
    "promoId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "houseNumber" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "deviceMac" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WifiPromoHouseGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WifiPromoHouseGrant_promoId_buildingId_houseNumber_key" ON "WifiPromoHouseGrant"("promoId", "buildingId", "houseNumber");
CREATE INDEX "WifiPromoHouseGrant_promoId_deviceMac_idx" ON "WifiPromoHouseGrant"("promoId", "deviceMac");
