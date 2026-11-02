CREATE TABLE "WifiNetworkCapacitySample" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connected" BOOLEAN NOT NULL,
    "wanLinkMbps" DOUBLE PRECISION,
    "wanDownloadMbps" DOUBLE PRECISION,
    "wanUploadMbps" DOUBLE PRECISION,
    "activeQueueCount" INTEGER NOT NULL DEFAULT 0,
    "guaranteedUploadMbps" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "guaranteedDownloadMbps" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overcommitted" BOOLEAN NOT NULL DEFAULT false,
    "ethernetLinks" JSONB,
    CONSTRAINT "WifiNetworkCapacitySample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WifiNetworkCapacitySample_createdAt_idx"
    ON "WifiNetworkCapacitySample"("createdAt");
CREATE INDEX "WifiNetworkCapacitySample_connected_createdAt_idx"
    ON "WifiNetworkCapacitySample"("connected", "createdAt");
