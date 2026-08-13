CREATE TABLE IF NOT EXISTS "WifiServiceHeartbeat" (
  "service" TEXT NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WifiServiceHeartbeat_pkey" PRIMARY KEY ("service")
);

CREATE TABLE IF NOT EXISTS "WifiOutageCredit" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "service" TEXT NOT NULL,
  "outageStartedAt" TIMESTAMP(3) NOT NULL,
  "outageEndedAt" TIMESTAMP(3) NOT NULL,
  "creditedSeconds" INTEGER NOT NULL,
  "affectedEntitlements" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WifiOutageCredit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WifiOutageCredit_service_outageStartedAt_outageEndedAt_key"
  ON "WifiOutageCredit" ("service", "outageStartedAt", "outageEndedAt");
CREATE INDEX IF NOT EXISTS "WifiOutageCredit_service_createdAt_idx" ON "WifiOutageCredit" ("service", "createdAt");
CREATE INDEX IF NOT EXISTS "WifiOutageCredit_outageStartedAt_outageEndedAt_idx" ON "WifiOutageCredit" ("outageStartedAt", "outageEndedAt");
