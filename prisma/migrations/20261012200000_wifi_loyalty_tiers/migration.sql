-- Weekly rewards v2: monthly points, tiers, and a reward row per customer
-- where they pick a card. Rounds picked under v1 (one fixed reward, winners
-- as JSON) were never given out, so they're cleared.
DELETE FROM "WifiLoyaltyRound" WHERE "status" = 'scheduled';

ALTER TABLE "WifiLoyaltySetting" DROP COLUMN "winnerCount",
  DROP COLUMN "rewardHours",
  DROP COLUMN "lookbackDays",
  ADD COLUMN "tiers" JSONB,
  ALTER COLUMN "minPaidDays" SET DEFAULT 3;
UPDATE "WifiLoyaltySetting" SET "minPaidDays" = 3 WHERE "minPaidDays" = 5;

ALTER TABLE "WifiLoyaltyRound" ADD COLUMN "month" TEXT;
UPDATE "WifiLoyaltyRound" SET "month" = to_char("weekOf" + interval '3 hours', 'YYYY-MM');
ALTER TABLE "WifiLoyaltyRound" ALTER COLUMN "month" SET NOT NULL,
  DROP COLUMN "rewardSeconds",
  DROP COLUMN "winners";

CREATE TABLE "WifiLoyaltyReward" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "deviceMac" TEXT,
    "rank" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "spentKsh" INTEGER NOT NULL,
    "paidDays" INTEGER NOT NULL,
    "tier" TEXT NOT NULL,
    "freeSeconds" INTEGER NOT NULL,
    "bonusSeconds" INTEGER NOT NULL,
    "speedBoostPct" INTEGER NOT NULL,
    "offerPlanIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "choice" TEXT,
    "claimedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "paymentIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WifiLoyaltyReward_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WifiLoyaltyReward_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "WifiLoyaltyRound"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WifiLoyaltyReward_roundId_customerPhone_key" ON "WifiLoyaltyReward"("roundId", "customerPhone");
CREATE INDEX "WifiLoyaltyReward_customerPhone_status_idx" ON "WifiLoyaltyReward"("customerPhone", "status");

ALTER TABLE "WifiPaymentIntent" ADD COLUMN "loyaltyRewardId" TEXT;
