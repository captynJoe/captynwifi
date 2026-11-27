-- One-time Housing -> WiFi link codes.
CREATE TABLE "WifiLinkCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "houseNumber" TEXT NOT NULL,
    "tenancyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "deviceMac" TEXT,
    CONSTRAINT "WifiLinkCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WifiLinkCode_code_key" ON "WifiLinkCode"("code");
CREATE INDEX "WifiLinkCode_phone_createdAt_idx" ON "WifiLinkCode"("phone", "createdAt");
