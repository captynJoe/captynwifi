-- Client Intelligence: device registry and change events.
CREATE TABLE "WifiDevice" (
    "mac" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "hostName" TEXT,
    "dhcpClassId" TEXT,
    "apMac" TEXT,
    "apName" TEXT,
    "ssid" TEXT,
    "band" TEXT,
    "rssi" INTEGER,
    "signalAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WifiDevice_pkey" PRIMARY KEY ("mac")
);
CREATE INDEX "WifiDevice_lastSeenAt_idx" ON "WifiDevice"("lastSeenAt");
CREATE INDEX "WifiDevice_hostName_idx" ON "WifiDevice"("hostName");
CREATE INDEX "WifiDevice_ip_idx" ON "WifiDevice"("ip");

CREATE TABLE "WifiDeviceEvent" (
    "id" TEXT NOT NULL,
    "mac" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "detail" JSONB,
    CONSTRAINT "WifiDeviceEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WifiDeviceEvent_mac_at_idx" ON "WifiDeviceEvent"("mac", "at");
CREATE INDEX "WifiDeviceEvent_at_idx" ON "WifiDeviceEvent"("at");
ALTER TABLE "WifiDeviceEvent" ADD CONSTRAINT "WifiDeviceEvent_mac_fkey" FOREIGN KEY ("mac") REFERENCES "WifiDevice"("mac") ON DELETE CASCADE ON UPDATE CASCADE;
