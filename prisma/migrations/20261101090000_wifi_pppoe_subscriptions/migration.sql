ALTER TABLE "WifiPaymentIntent" ADD COLUMN "accessType" TEXT NOT NULL DEFAULT 'hotspot';

CREATE TABLE "WifiPppoeAccount" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "cleartextSecret" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rateLimit" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WifiPppoeAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WifiPppoeSubscription" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "amountKsh" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WifiPppoeSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WifiPppoeAccount_username_key" ON "WifiPppoeAccount"("username");
CREATE UNIQUE INDEX "WifiPppoeAccount_siteId_customerPhone_key" ON "WifiPppoeAccount"("siteId", "customerPhone");
CREATE INDEX "WifiPppoeAccount_status_expiresAt_idx" ON "WifiPppoeAccount"("status", "expiresAt");
CREATE UNIQUE INDEX "WifiPppoeSubscription_paymentIntentId_key" ON "WifiPppoeSubscription"("paymentIntentId");
CREATE INDEX "WifiPppoeSubscription_accountId_startsAt_idx" ON "WifiPppoeSubscription"("accountId", "startsAt");

ALTER TABLE "WifiPppoeAccount" ADD CONSTRAINT "WifiPppoeAccount_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WifiSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WifiPppoeAccount" ADD CONSTRAINT "WifiPppoeAccount_planId_fkey" FOREIGN KEY ("planId") REFERENCES "WifiPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WifiPppoeSubscription" ADD CONSTRAINT "WifiPppoeSubscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WifiPppoeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WifiPppoeSubscription" ADD CONSTRAINT "WifiPppoeSubscription_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "WifiPaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WifiPppoeSubscription" ADD CONSTRAINT "WifiPppoeSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "WifiPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
