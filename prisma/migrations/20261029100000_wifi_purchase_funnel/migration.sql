ALTER TABLE "WifiPaymentIntent" ADD COLUMN "funnelSessionId" TEXT;

CREATE INDEX "WifiPaymentIntent_funnelSessionId_status_createdAt_idx"
  ON "WifiPaymentIntent"("funnelSessionId", "status", "createdAt");

CREATE TABLE "WifiFunnelEvent" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "planId" TEXT,
  "fromPlanId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WifiFunnelEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WifiFunnelEvent_createdAt_event_idx" ON "WifiFunnelEvent"("createdAt", "event");
CREATE INDEX "WifiFunnelEvent_sessionId_createdAt_idx" ON "WifiFunnelEvent"("sessionId", "createdAt");
CREATE INDEX "WifiFunnelEvent_planId_event_createdAt_idx" ON "WifiFunnelEvent"("planId", "event", "createdAt");
