import "dotenv/config";
import crypto from "node:crypto";

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function readNonNegativeInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

const runtimeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
const allowInsecureDevSecrets = runtimeEnv === "development" || runtimeEnv === "test";
const KNOWN_UNSAFE_SECRET_MARKERS = ["change-me", "change-", "dev-captyn-wifi", "dev-"];

function isUnsafeSecretValue(value: string): boolean {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  return trimmed.length < 24 || KNOWN_UNSAFE_SECRET_MARKERS.some((marker) => lowered.includes(marker));
}

function readRequiredSecret(name: string, devFallback: string): string {
  const configured = process.env[name]?.trim() ?? "";
  if (configured && !isUnsafeSecretValue(configured)) return configured;
  if (allowInsecureDevSecrets) return configured || devFallback;
  throw new Error(`${name} must be set to a non-placeholder value of at least 24 characters.`);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readMpesaValue(name: string): string {
  return process.env[`CAPTYN_WIFI_${name}`]?.trim() || process.env[name]?.trim() || "";
}

function readSessionSecret(): string {
  const configured = process.env.CAPTYN_WIFI_ADMIN_SESSION_SECRET?.trim() ?? "";
  if (configured && !isUnsafeSecretValue(configured)) return configured;

  if (allowInsecureDevSecrets) {
    return crypto.createHash("sha256").update(configured || "dev-captyn-wifi-admin-session-secret").digest("hex");
  }

  throw new Error("CAPTYN_WIFI_ADMIN_SESSION_SECRET must be set to a non-placeholder value of at least 24 characters.");
}

export const config = {
  port: readPositiveInt("PORT", 4120),
  corsOrigin: process.env.CORS_ORIGIN ?? "https://housing.captyn.shop",
  integrationToken: readRequiredSecret("CAPTYN_WIFI_INTEGRATION_TOKEN", "dev-captyn-wifi-token"),
  adminDatabaseUrl: process.env.CAPTYN_ADMIN_DATABASE_URL ?? "",
  adminRootEmails: process.env.ADMIN_ROOT_EMAILS ?? process.env.ROOT_ADMIN_EMAILS ?? process.env.ADMIN_EMAIL ?? "",
  adminSessionSecret: readSessionSecret(),
  adminSessionMaxAgeSeconds: readPositiveInt("CAPTYN_WIFI_ADMIN_SESSION_MAX_AGE_SECONDS", 60 * 60 * 12),
  adminTrustedDeviceMaxAgeSeconds: readPositiveInt("CAPTYN_WIFI_ADMIN_TRUSTED_DEVICE_MAX_AGE_SECONDS", 60 * 60 * 24 * 30),
  adminPasswordOnlyLogin: allowInsecureDevSecrets && readBoolean("CAPTYN_WIFI_ADMIN_PASSWORD_ONLY_LOGIN"),
  totpEncryptionKey: process.env.TOTP_ENCRYPTION_KEY ?? "",
  defaultRadiusRealm: process.env.DEFAULT_RADIUS_REALM ?? "captyn-wifi",
  defaultAcctInterimSeconds: readPositiveInt("DEFAULT_ACCT_INTERIM_INTERVAL_SECONDS", 120),
  defaultIdleTimeoutSeconds: readNonNegativeInt("CAPTYN_WIFI_IDLE_TIMEOUT_SECONDS", 60 * 60 * 6),
  radiusSql: {
    enabled: readBoolean("CAPTYN_WIFI_RADIUS_SQL_ENABLED", true),
    pollIntervalMs: readPositiveMs("CAPTYN_WIFI_RADIUS_SQL_POLL_INTERVAL_MS", 5000),
    batchSize: readPositiveInt("CAPTYN_WIFI_RADIUS_SQL_BATCH_SIZE", 25)
  },
  outageCredit: {
    enabled: readBoolean("CAPTYN_WIFI_OUTAGE_CREDIT_ENABLED", true),
    serviceName: process.env.CAPTYN_WIFI_OUTAGE_CREDIT_SERVICE?.trim() || "captyn-wifi-radius-worker",
    graceSeconds: readPositiveInt("CAPTYN_WIFI_OUTAGE_CREDIT_GRACE_SECONDS", 180),
    accountingGraceSeconds: readPositiveInt("CAPTYN_WIFI_OUTAGE_CREDIT_ACCOUNTING_GRACE_SECONDS", 300),
    maxCreditSeconds: readPositiveInt("CAPTYN_WIFI_OUTAGE_CREDIT_MAX_SECONDS", 60 * 60 * 24),
    batchSize: readPositiveInt("CAPTYN_WIFI_OUTAGE_CREDIT_BATCH_SIZE", 500)
  },
  routeros: {
    enabled: readBoolean("CAPTYN_WIFI_ROUTEROS_ENABLED"),
    host: process.env.CAPTYN_WIFI_ROUTEROS_HOST?.trim() || "",
    port: readPositiveInt("CAPTYN_WIFI_ROUTEROS_PORT", 8728),
    username: process.env.CAPTYN_WIFI_ROUTEROS_USERNAME?.trim() || "",
    password: process.env.CAPTYN_WIFI_ROUTEROS_PASSWORD ?? "",
    timeoutMs: readPositiveMs("CAPTYN_WIFI_ROUTEROS_TIMEOUT_MS", 5000)
  },
  governor: {
    enabled: readBoolean("CAPTYN_WIFI_GOVERNOR_ENABLED"),
    dryRun: readBoolean("CAPTYN_WIFI_GOVERNOR_DRY_RUN", true),
    applyRadiusSql: readBoolean("CAPTYN_WIFI_GOVERNOR_APPLY_RADIUS_SQL"),
    kickOnChange: readBoolean("CAPTYN_WIFI_GOVERNOR_KICK_ON_CHANGE"),
    pollIntervalMs: readPositiveMs("CAPTYN_WIFI_GOVERNOR_POLL_INTERVAL_MS", 15000),
    activeWindowSeconds: readPositiveInt("CAPTYN_WIFI_GOVERNOR_ACTIVE_WINDOW_SECONDS", 180),
    wanDownloadMbps: readPositiveNumber("CAPTYN_WIFI_GOVERNOR_WAN_DOWNLOAD_MBPS", 140),
    wanUploadMbps: readPositiveNumber("CAPTYN_WIFI_GOVERNOR_WAN_UPLOAD_MBPS", 40),
    enterYellowMs: readPositiveMs("CAPTYN_WIFI_GOVERNOR_ENTER_YELLOW_MS", 60000),
    enterRedMs: readPositiveMs("CAPTYN_WIFI_GOVERNOR_ENTER_RED_MS", 60000),
    enterCriticalMs: readPositiveMs("CAPTYN_WIFI_GOVERNOR_ENTER_CRITICAL_MS", 30000),
    recoverMs: readPositiveMs("CAPTYN_WIFI_GOVERNOR_RECOVER_MS", 180000)
  },
  dynamicPlan: {
    enabled: readBoolean("CAPTYN_WIFI_DYNAMIC_PLAN_ENABLED"),
    dryRun: readBoolean("CAPTYN_WIFI_DYNAMIC_PLAN_DRY_RUN", true),
    rotationMs: readPositiveMs("CAPTYN_WIFI_DYNAMIC_PLAN_ROTATION_MS", 60 * 60 * 1000)
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
    transactionType: readMpesaValue("MPESA_STK_TRANSACTION_TYPE") || readMpesaValue("MPESA_TRANSACTION_TYPE") || "CustomerBuyGoodsOnline",
    // How long a payment intent can sit in pending_confirmation with no M-PESA
    // callback before the worker gives up on it and marks it failed. Matches
    // the "stale" cutoff already used for the admin network-status metric, so
    // that count naturally drains instead of just flagging forever.
    pendingTimeoutSeconds: readPositiveInt("CAPTYN_WIFI_MPESA_PENDING_TIMEOUT_SECONDS", 15 * 60)
  }
};
