CREATE TABLE "WifiCredit" (
    "id" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceReference" TEXT,
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "consumedEntitlementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "metadata" JSONB,

    CONSTRAINT "WifiCredit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WifiCredit_customerPhone_consumedAt_expiresAt_idx" ON "WifiCredit"("customerPhone", "consumedAt", "expiresAt");

CREATE INDEX "WifiCredit_sourceReference_idx" ON "WifiCredit"("sourceReference");

CREATE TABLE "WifiNotification" (
    "id" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WifiNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WifiNotification_customerPhone_readAt_createdAt_idx" ON "WifiNotification"("customerPhone", "readAt", "createdAt");
