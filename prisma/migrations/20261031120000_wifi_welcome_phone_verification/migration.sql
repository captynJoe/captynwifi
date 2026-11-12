CREATE TABLE "WifiWelcomeClaim" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "deviceMacHash" TEXT NOT NULL,
  "entitlementId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WifiWelcomeClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WifiWelcomeClaim_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "WifiEntitlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WifiWelcomeClaim_phone_key" ON "WifiWelcomeClaim"("phone");
CREATE UNIQUE INDEX "WifiWelcomeClaim_deviceMacHash_key" ON "WifiWelcomeClaim"("deviceMacHash");
CREATE UNIQUE INDEX "WifiWelcomeClaim_entitlementId_key" ON "WifiWelcomeClaim"("entitlementId");
CREATE INDEX "WifiWelcomeClaim_createdAt_idx" ON "WifiWelcomeClaim"("createdAt");

CREATE TABLE "WifiWelcomeOtpChallenge" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "deviceMac" TEXT NOT NULL,
  "funnelSessionId" TEXT,
  "codeHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WifiWelcomeOtpChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WifiWelcomeOtpChallenge_phone_createdAt_idx" ON "WifiWelcomeOtpChallenge"("phone", "createdAt");
CREATE INDEX "WifiWelcomeOtpChallenge_expiresAt_consumedAt_idx" ON "WifiWelcomeOtpChallenge"("expiresAt", "consumedAt");
