CREATE TABLE "WifiMpesaUnmatchedCallback" (
    "id" TEXT NOT NULL,
    "checkoutRequestId" TEXT NOT NULL,
    "resultCode" INTEGER NOT NULL,
    "resultDescription" TEXT,
    "receiptNumber" TEXT,
    "amountKsh" INTEGER,
    "customerPhone" TEXT,
    "rawPayload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unmatched',
    "matchedPaymentIntentId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WifiMpesaUnmatchedCallback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WifiMpesaUnmatchedCallback_checkoutRequestId_key"
    ON "WifiMpesaUnmatchedCallback"("checkoutRequestId");
CREATE INDEX "WifiMpesaUnmatchedCallback_status_receivedAt_idx"
    ON "WifiMpesaUnmatchedCallback"("status", "receivedAt");
CREATE INDEX "WifiMpesaUnmatchedCallback_receiptNumber_idx"
    ON "WifiMpesaUnmatchedCallback"("receiptNumber");
CREATE INDEX "WifiMpesaUnmatchedCallback_customerPhone_receivedAt_idx"
    ON "WifiMpesaUnmatchedCallback"("customerPhone", "receivedAt");
