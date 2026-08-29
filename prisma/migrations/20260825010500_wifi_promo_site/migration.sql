ALTER TABLE "WifiPromo" ADD COLUMN "siteId" TEXT NOT NULL;

ALTER TABLE "WifiPromo" ADD CONSTRAINT "WifiPromo_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WifiSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "WifiPromo_siteId_idx" ON "WifiPromo"("siteId");
