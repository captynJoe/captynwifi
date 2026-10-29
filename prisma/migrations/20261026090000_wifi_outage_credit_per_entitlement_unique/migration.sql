-- Credit each resumed entitlement independently, even when several customers
-- reconnect within the same timestamp window.
DROP INDEX IF EXISTS "WifiOutageCredit_service_outageStartedAt_outageEndedAt_key";
CREATE UNIQUE INDEX "WifiOutageCredit_per_entitlement_key"
  ON "WifiOutageCredit" ("service", "outageStartedAt", "outageEndedAt", "entitlementId");
