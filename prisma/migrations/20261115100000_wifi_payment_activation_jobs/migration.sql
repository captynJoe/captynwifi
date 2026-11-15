CREATE TYPE "WifiPaymentActivationJobStatus" AS ENUM ('queued', 'processing', 'completed');

CREATE TABLE "WifiPaymentActivationJob" (
    "id" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "status" "WifiPaymentActivationJobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastAlertedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WifiPaymentActivationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WifiPaymentActivationJob_paymentIntentId_key" ON "WifiPaymentActivationJob"("paymentIntentId");
CREATE INDEX "WifiPaymentActivationJob_status_nextAttemptAt_idx" ON "WifiPaymentActivationJob"("status", "nextAttemptAt");
CREATE INDEX "WifiPaymentActivationJob_status_lockedAt_idx" ON "WifiPaymentActivationJob"("status", "lockedAt");
ALTER TABLE "WifiPaymentActivationJob" ADD CONSTRAINT "WifiPaymentActivationJob_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "WifiPaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve recoverability for payments confirmed before this queue existed.
INSERT INTO "WifiPaymentActivationJob" ("id", "paymentIntentId", "status", "nextAttemptAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, id, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "WifiPaymentIntent"
WHERE status = 'confirmed' AND provider = 'mpesa' AND "providerReference" IS NOT NULL
ON CONFLICT ("paymentIntentId") DO NOTHING;
