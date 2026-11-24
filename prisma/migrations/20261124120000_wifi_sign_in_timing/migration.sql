-- Portal-reported sign-in timings (path, per-step durations, outcome).
CREATE TABLE "WifiSignInTiming" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "totalMs" INTEGER NOT NULL,
    "steps" JSONB,
    "userAgent" TEXT,
    CONSTRAINT "WifiSignInTiming_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WifiSignInTiming_createdAt_idx" ON "WifiSignInTiming"("createdAt");
