-- Trace Any Client: who revealed what, and fast lookups of accounting by MAC.
CREATE TABLE "WifiAuditEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "detail" JSONB,
    CONSTRAINT "WifiAuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WifiAuditEvent_createdAt_idx" ON "WifiAuditEvent"("createdAt");
CREATE INDEX "WifiAuditEvent_target_createdAt_idx" ON "WifiAuditEvent"("target", "createdAt");

CREATE INDEX IF NOT EXISTS radacct_callingstationid_upper_idx ON radacct (upper(callingstationid));
CREATE INDEX IF NOT EXISTS radacct_framedipaddress_idx ON radacct (framedipaddress);
CREATE INDEX IF NOT EXISTS "WifiPaymentIntent_receiptNumber_providerReference_idx" ON "WifiPaymentIntent" ("providerReference");
