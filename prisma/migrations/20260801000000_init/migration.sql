-- CreateEnum
CREATE TYPE "WifiPaymentIntentStatus" AS ENUM ('pending_confirmation', 'confirmed', 'failed', 'paid_pending_activation', 'activated');

-- CreateEnum
CREATE TYPE "WifiEntitlementStatus" AS ENUM ('pending_activation', 'active', 'expired', 'suspended', 'revoked');

-- CreateEnum
CREATE TYPE "WifiProjectionStatus" AS ENUM ('pending', 'applied', 'failed');

-- CreateTable
CREATE TABLE "WifiSite" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'captyn_housing',
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WifiSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WifiPlan" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'captyn_housing',
    "externalPackageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "priceKsh" INTEGER NOT NULL,
    "rateLimit" TEXT,
    "deviceLimit" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WifiPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WifiPaymentIntent" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'captyn_housing',
    "sourceReference" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "deviceMac" TEXT,
    "amountKsh" INTEGER NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mpesa',
    "providerReference" TEXT,
    "status" "WifiPaymentIntentStatus" NOT NULL DEFAULT 'pending_confirmation',
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "WifiPaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WifiEntitlement" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "cleartextSecret" TEXT NOT NULL,
    "deviceMac" TEXT,
    "status" "WifiEntitlementStatus" NOT NULL DEFAULT 'pending_activation',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deviceLimit" INTEGER NOT NULL DEFAULT 1,
    "rateLimit" TEXT,
    "acctInterimSeconds" INTEGER NOT NULL DEFAULT 120,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WifiEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WifiRadiusProjection" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "status" "WifiProjectionStatus" NOT NULL DEFAULT 'pending',
    "username" TEXT NOT NULL,
    "checkItems" JSONB NOT NULL,
    "replyItems" JSONB NOT NULL,
    "lastError" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WifiRadiusProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WifiAccountingSession" (
    "id" TEXT NOT NULL,
    "acctSessionId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "entitlementClass" TEXT,
    "callingStationId" TEXT,
    "calledStationId" TEXT,
    "nasIpAddress" TEXT,
    "nasIdentifier" TEXT,
    "framedIpAddress" TEXT,
    "acctSessionTimeSeconds" INTEGER,
    "inputOctets" BIGINT,
    "outputOctets" BIGINT,
    "terminateCause" TEXT,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "lastInterimAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WifiAccountingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WifiSite_source_externalId_key" ON "WifiSite"("source", "externalId");
CREATE INDEX "WifiSite_source_idx" ON "WifiSite"("source");

-- CreateIndex
CREATE UNIQUE INDEX "WifiPlan_siteId_source_externalPackageId_key" ON "WifiPlan"("siteId", "source", "externalPackageId");
CREATE INDEX "WifiPlan_siteId_enabled_idx" ON "WifiPlan"("siteId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "WifiPaymentIntent_source_sourceReference_key" ON "WifiPaymentIntent"("source", "sourceReference");
CREATE INDEX "WifiPaymentIntent_siteId_status_createdAt_idx" ON "WifiPaymentIntent"("siteId", "status", "createdAt");
CREATE INDEX "WifiPaymentIntent_provider_providerReference_idx" ON "WifiPaymentIntent"("provider", "providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "WifiEntitlement_paymentIntentId_key" ON "WifiEntitlement"("paymentIntentId");
CREATE INDEX "WifiEntitlement_siteId_status_expiresAt_idx" ON "WifiEntitlement"("siteId", "status", "expiresAt");
CREATE INDEX "WifiEntitlement_username_idx" ON "WifiEntitlement"("username");

-- CreateIndex
CREATE UNIQUE INDEX "WifiRadiusProjection_entitlementId_key" ON "WifiRadiusProjection"("entitlementId");
CREATE INDEX "WifiRadiusProjection_status_updatedAt_idx" ON "WifiRadiusProjection"("status", "updatedAt");
CREATE INDEX "WifiRadiusProjection_username_idx" ON "WifiRadiusProjection"("username");

-- CreateIndex
CREATE UNIQUE INDEX "WifiAccountingSession_acctSessionId_username_key" ON "WifiAccountingSession"("acctSessionId", "username");
CREATE INDEX "WifiAccountingSession_username_idx" ON "WifiAccountingSession"("username");
CREATE INDEX "WifiAccountingSession_nasIdentifier_idx" ON "WifiAccountingSession"("nasIdentifier");
CREATE INDEX "WifiAccountingSession_lastInterimAt_idx" ON "WifiAccountingSession"("lastInterimAt");

-- AddForeignKey
ALTER TABLE "WifiPlan" ADD CONSTRAINT "WifiPlan_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WifiSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WifiPaymentIntent" ADD CONSTRAINT "WifiPaymentIntent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WifiSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WifiPaymentIntent" ADD CONSTRAINT "WifiPaymentIntent_planId_fkey" FOREIGN KEY ("planId") REFERENCES "WifiPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WifiEntitlement" ADD CONSTRAINT "WifiEntitlement_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WifiSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WifiEntitlement" ADD CONSTRAINT "WifiEntitlement_planId_fkey" FOREIGN KEY ("planId") REFERENCES "WifiPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WifiEntitlement" ADD CONSTRAINT "WifiEntitlement_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "WifiPaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WifiRadiusProjection" ADD CONSTRAINT "WifiRadiusProjection_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "WifiEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
