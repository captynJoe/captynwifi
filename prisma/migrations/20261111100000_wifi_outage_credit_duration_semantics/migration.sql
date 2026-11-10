ALTER TABLE "WifiEntitlement"
  ADD COLUMN "outageRemainingSeconds" DOUBLE PRECISION;

UPDATE "WifiEntitlement"
SET "outageRemainingSeconds" = GREATEST(
  0,
  EXTRACT(EPOCH FROM ("expiresAt" - "outagePausedAt"))::DOUBLE PRECISION
)
WHERE "outagePausedAt" IS NOT NULL;

ALTER TABLE "WifiOutageCredit"
  ADD COLUMN "remainingSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Historically creditedSeconds stored the package balance frozen at outage
-- start. Preserve that audit value, and make creditedSeconds consistently
-- report the actual outage duration displayed to admins and customers.
UPDATE "WifiOutageCredit"
SET "remainingSeconds" = "creditedSeconds",
    "creditedSeconds" = GREATEST(
      0,
      FLOOR(EXTRACT(EPOCH FROM ("outageEndedAt" - "outageStartedAt")))::INTEGER
    );
