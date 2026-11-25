-- Customer accounts: SMS-confirmed phones, sessions, device-code sign-in attempts.
CREATE TABLE "WifiPhoneVerification" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "deviceMac" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "WifiPhoneVerification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WifiPhoneVerification_phone_createdAt_idx" ON "WifiPhoneVerification"("phone", "createdAt");

CREATE TABLE "WifiAccountSession" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceMac" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "WifiAccountSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WifiAccountSession_tokenHash_key" ON "WifiAccountSession"("tokenHash");
CREATE INDEX "WifiAccountSession_phone_idx" ON "WifiAccountSession"("phone");

CREATE TABLE "WifiAccountSignInAttempt" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "deviceMac" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WifiAccountSignInAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WifiAccountSignInAttempt_phone_at_idx" ON "WifiAccountSignInAttempt"("phone", "at");
