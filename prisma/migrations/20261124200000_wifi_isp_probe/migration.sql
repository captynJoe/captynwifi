-- Evening ISP line probe.
CREATE TABLE "WifiIspProbe" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "probeMbps" DOUBLE PRECISION,
    "customerMbps" DOUBLE PRECISION,
    "totalMbps" DOUBLE PRECISION,
    "bytes" INTEGER,
    "seconds" DOUBLE PRECISION,
    "error" TEXT,
    CONSTRAINT "WifiIspProbe_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WifiIspProbe_at_idx" ON "WifiIspProbe"("at");
