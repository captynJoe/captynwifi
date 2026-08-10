CREATE TABLE IF NOT EXISTS "WifiGovernorEvent" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "state" TEXT NOT NULL,
  "dryRun" BOOLEAN NOT NULL DEFAULT true,
  "activeSessionCount" INTEGER NOT NULL DEFAULT 0,
  "activeDemandMbps" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "utilizationScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "username" TEXT,
  "entitlementId" TEXT,
  "previousRateLimit" TEXT,
  "targetRateLimit" TEXT,
  "reason" TEXT NOT NULL,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WifiGovernorEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WifiGovernorEvent_createdAt_idx" ON "WifiGovernorEvent" ("createdAt");
CREATE INDEX IF NOT EXISTS "WifiGovernorEvent_state_createdAt_idx" ON "WifiGovernorEvent" ("state", "createdAt");
CREATE INDEX IF NOT EXISTS "WifiGovernorEvent_username_createdAt_idx" ON "WifiGovernorEvent" ("username", "createdAt");
