-- Store the confirmed M-PESA receipt number so a customer can reconnect by
-- pasting their transaction code, and index active entitlements by device
-- MAC so returning devices with live access can be auto-connected.
ALTER TABLE "WifiPaymentIntent" ADD COLUMN "receiptNumber" TEXT;

CREATE INDEX "WifiPaymentIntent_receiptNumber_idx" ON "WifiPaymentIntent"("receiptNumber");

CREATE INDEX "WifiEntitlement_deviceMac_status_expiresAt_idx" ON "WifiEntitlement"("deviceMac", "status", "expiresAt");
