-- AlterTable
ALTER TABLE "WifiEntitlement" ADD COLUMN "connectCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WifiEntitlement_connectCode_key" ON "WifiEntitlement"("connectCode");
