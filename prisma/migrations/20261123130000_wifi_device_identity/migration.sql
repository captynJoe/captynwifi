-- DHCP identity captured when CAPTYN signs a device in from the server, so
-- automatic re-sign-in can require more than a matching MAC.
ALTER TABLE "WifiEntitlementDevice" ADD COLUMN "hostName" TEXT;
ALTER TABLE "WifiEntitlementDevice" ADD COLUMN "dhcpClassId" TEXT;
ALTER TABLE "WifiEntitlementDevice" ADD COLUMN "dhcpClientId" TEXT;
ALTER TABLE "WifiEntitlementDevice" ADD COLUMN "identitySeenAt" TIMESTAMP(3);
