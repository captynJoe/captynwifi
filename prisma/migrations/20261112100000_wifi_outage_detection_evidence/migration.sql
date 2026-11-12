ALTER TABLE "WifiEntitlement"
  ADD COLUMN "outageEvidence" JSONB;

ALTER TABLE "WifiOutageCredit"
  ADD COLUMN evidence JSONB;
