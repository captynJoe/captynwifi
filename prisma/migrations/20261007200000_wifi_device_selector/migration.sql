-- Device selector: customers choose how many devices a package covers.
ALTER TABLE "WifiPlan" ADD COLUMN "maxDevices" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "WifiPaymentIntent" ADD COLUMN "deviceCount" INTEGER;
ALTER TABLE "WifiPaymentIntent" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'purchase';
ALTER TABLE "WifiPaymentIntent" ADD COLUMN "targetEntitlementId" TEXT;
