-- Once-per-tenancy reward for linking a Village Inn tenant's phone.
CREATE TABLE "WifiLinkReward" (
    "id" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "houseNumber" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "creditId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WifiLinkReward_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WifiLinkReward_tenancyId_key" ON "WifiLinkReward"("tenancyId");
