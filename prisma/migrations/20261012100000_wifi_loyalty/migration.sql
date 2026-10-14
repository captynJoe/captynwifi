-- Weekly reward for regulars (see WifiLoyaltySetting / WifiLoyaltyRound).
CREATE TABLE "WifiLoyaltySetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "winnerCount" INTEGER NOT NULL DEFAULT 30,
    "rewardHours" INTEGER[] DEFAULT ARRAY[6]::INTEGER[],
    "claimDays" INTEGER NOT NULL DEFAULT 7,
    "lookbackDays" INTEGER NOT NULL DEFAULT 30,
    "minPaidDays" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WifiLoyaltySetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WifiLoyaltyRound" (
    "id" TEXT NOT NULL,
    "weekOf" TIMESTAMP(3) NOT NULL,
    "releaseAt" TIMESTAMP(3) NOT NULL,
    "rewardSeconds" INTEGER NOT NULL,
    "claimDays" INTEGER NOT NULL,
    "winners" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WifiLoyaltyRound_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WifiLoyaltyRound_weekOf_key" ON "WifiLoyaltyRound"("weekOf");
CREATE INDEX "WifiLoyaltyRound_status_releaseAt_idx" ON "WifiLoyaltyRound"("status", "releaseAt");
