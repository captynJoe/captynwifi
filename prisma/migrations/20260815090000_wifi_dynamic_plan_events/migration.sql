CREATE TABLE IF NOT EXISTS "WifiDynamicPlanEvent" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "siteId" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "dryRun" BOOLEAN NOT NULL DEFAULT true,
  "avgUtilizationScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sampleCount" INTEGER NOT NULL DEFAULT 0,
  "windowStartsAt" TIMESTAMP(3) NOT NULL,
  "windowEndsAt" TIMESTAMP(3) NOT NULL,
  "planId" TEXT,
  "durationSeconds" INTEGER,
  "priceKsh" INTEGER,
  "rateLimit" TEXT,
  "published" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WifiDynamicPlanEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WifiDynamicPlanEvent_siteId_createdAt_idx" ON "WifiDynamicPlanEvent" ("siteId", "createdAt");
