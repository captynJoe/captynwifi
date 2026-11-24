-- Client Intelligence alerts.
CREATE TABLE "WifiIntelAlert" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "WifiIntelAlert_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WifiIntelAlert_key_resolvedAt_idx" ON "WifiIntelAlert"("key", "resolvedAt");
CREATE INDEX "WifiIntelAlert_resolvedAt_lastSeenAt_idx" ON "WifiIntelAlert"("resolvedAt", "lastSeenAt");
