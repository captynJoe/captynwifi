ALTER TABLE "WifiEntitlement" ADD COLUMN "promoPausedAt" TIMESTAMP(3);

CREATE INDEX "WifiEntitlement_promoPausedAt_idx" ON "WifiEntitlement"("promoPausedAt");

CREATE TABLE "WifiPromo" (
    "id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "heading" TEXT,
    "message" TEXT,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "rateLimit" TEXT,
    "deviceLimit" INTEGER NOT NULL DEFAULT 1,
    "pauseExisting" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WifiPromo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WifiPromo_active_idx" ON "WifiPromo"("active");
