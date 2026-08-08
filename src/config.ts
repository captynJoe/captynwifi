import "dotenv/config";
import crypto from "node:crypto";

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function readPositiveMs(name: string, fallback: number): number {
  const value = readPositiveInt(name, fallback);
  return Math.max(1000, value);
}

function readBoolean(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readMpesaValue(name: string): string {
  return process.env[`CAPTYN_WIFI_${name}`]?.trim() || process.env[name]?.trim() || "";
}

function readSessionSecret(): string {
  const configured = process.env.CAPTYN_WIFI_ADMIN_SESSION_SECRET?.trim();
  if (configured) return configured;

  const fallback = process.env.CAPTYN_WIFI_ADMIN_TOKEN?.trim() || process.env.CAPTYN_WIFI_INTEGRATION_TOKEN?.trim();
  if (fallback) return fallback;

  return crypto.createHash("sha256").update("dev-captyn-wifi-admin-session-secret").digest("hex");
}

export const config = {
  port: readPositiveInt("PORT", 4120),
  corsOrigin: process.env.CORS_ORIGIN ?? "https://housing.captyn.shop",
  integrationToken: process.env.CAPTYN_WIFI_INTEGRATION_TOKEN ?? "dev-captyn-wifi-token",
  adminDatabaseUrl: process.env.CAPTYN_ADMIN_DATABASE_URL ?? "",
  adminRootEmails: process.env.ADMIN_ROOT_EMAILS ?? process.env.ROOT_ADMIN_EMAILS ?? process.env.ADMIN_EMAIL ?? "",
  adminSessionSecret: readSessionSecret(),
  adminSessionMaxAgeSeconds: readPositiveInt("CAPTYN_WIFI_ADMIN_SESSION_MAX_AGE_SECONDS", 60 * 60 * 12),
  adminTrustedDeviceMaxAgeSeconds: readPositiveInt("CAPTYN_WIFI_ADMIN_TRUSTED_DEVICE_MAX_AGE_SECONDS", 60 * 60 * 24 * 30),
  totpEncryptionKey: process.env.TOTP_ENCRYPTION_KEY ?? "",
  defaultRadiusRealm: process.env.DEFAULT_RADIUS_REALM ?? "captyn-wifi",
  defaultAcctInterimSeconds: readPositiveInt("DEFAULT_ACCT_INTERIM_INTERVAL_SECONDS", 120),
  radiusSql: {
    enabled: readBoolean("CAPTYN_WIFI_RADIUS_SQL_ENABLED", true),
    pollIntervalMs: readPositiveMs("CAPTYN_WIFI_RADIUS_SQL_POLL_INTERVAL_MS", 5000),
    batchSize: readPositiveInt("CAPTYN_WIFI_RADIUS_SQL_BATCH_SIZE", 25)
  },
  mpesa: {
    enabled: readBoolean("CAPTYN_WIFI_MPESA_STK_ENABLED", readBoolean("MPESA_STK_ENABLED")),
    environment: readMpesaValue("MPESA_ENVIRONMENT").toLowerCase() === "sandbox" ? "sandbox" : "production",
    baseUrl: stripTrailingSlash(
      readMpesaValue("MPESA_BASE_URL") ||
        (readMpesaValue("MPESA_ENVIRONMENT").toLowerCase() === "sandbox"
          ? "https://sandbox.safaricom.co.ke"
          : "https://api.safaricom.co.ke")
    ),
    consumerKey: readMpesaValue("MPESA_CONSUMER_KEY"),
    consumerSecret: readMpesaValue("MPESA_CONSUMER_SECRET"),
    shortCode:
      readMpesaValue("MPESA_BUSINESS_SHORT_CODE") ||
      readMpesaValue("MPESA_BUSINESS_SHORTCODE") ||
      readMpesaValue("MPESA_SHORT_CODE") ||
      readMpesaValue("MPESA_SHORTCODE"),
    partyB: readMpesaValue("MPESA_PARTY_B") || readMpesaValue("MPESA_STORE_NUMBER"),
    passkey: readMpesaValue("MPESA_PASSKEY") || readMpesaValue("MPESA_STK_PASSKEY"),
    callbackUrl: readMpesaValue("MPESA_CALLBACK_URL") || "https://captyn.shop/wifi/api/public/payments/mpesa/callback",
    transactionType: readMpesaValue("MPESA_STK_TRANSACTION_TYPE") || readMpesaValue("MPESA_TRANSACTION_TYPE") || "CustomerBuyGoodsOnline"
  }
};
