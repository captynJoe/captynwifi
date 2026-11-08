CREATE TABLE "WifiSpeedColorSetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "tiers" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WifiSpeedColorSetting_pkey" PRIMARY KEY ("id")
);
