import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import speakeasy from "speakeasy";
import { z } from "zod";
import { config } from "./config.js";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const DUMMY_PASSWORD_HASH = "$2b$10$KbQiHKDg.sJz8fY5vY9xROkwL4u24BEAp23Y4aZ3wE3Fh0eFV5QzO";
const EMAIL_SPLIT = /[\s,;]+/;

type AdminRole = "admin" | "root_admin";

type AdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  isAdmin: boolean;
  isPro: boolean;
  status: string;
  emailVerified: Date | null;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  twoFactorBackupCodes: string[] | null;
  twoFactorFailedAttempts: number | null;
  twoFactorLockedUntil: Date | null;
  twoFactorMethod: string | null;
};

export type WifiAdminSession = {
  sub: string;
  email: string;
  name: string | null;
  role: AdminRole;
  iat: number;
  exp: number;
};

type WifiTrustedDevice = {
  scope: "wifi_admin_trusted_device";
  sub: string;
  email: string;
  iat: number;
  exp: number;
};

export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  twoFactorCode: z.string().optional(),
  backupCode: z.string().optional(),
  trustedDeviceToken: z.string().optional(),
  trustDevice: z.boolean().optional()
});

export const trustedSessionSchema = z.object({
  trustedDeviceToken: z.string().min(1)
});

let adminDb: PrismaClient | null = null;

function getAdminDb(): PrismaClient {
  if (!config.adminDatabaseUrl) {
    throw new Error("CAPTYN admin credential database is not configured.");
  }
  if (!adminDb) {
    adminDb = new PrismaClient({
      datasources: { db: { url: config.adminDatabaseUrl } }
    });
  }
  return adminDb;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function parseBase64urlJson<T>(input: string): T | null {
  try {
    return JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as T;
  } catch (_error) {
    return null;
  }
}

function sign(value: string): string {
  return crypto.createHmac("sha256", config.adminSessionSecret).update(value).digest("base64url");
}

function normalizeEmail(email: string | null | undefined): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function normalizeBackupCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function rootAdminEmails(): Set<string> {
  const emails = new Set<string>();
  for (const part of config.adminRootEmails.split(EMAIL_SPLIT)) {
    const email = normalizeEmail(part);
    if (email) emails.add(email);
  }
  return emails;
}

function resolveAdminRole(user: Pick<AdminUserRow, "email" | "isAdmin">): AdminRole {
  if (rootAdminEmails().has(normalizeEmail(user.email))) return "root_admin";
  return "admin";
}

function getEncryptionKey(): Buffer {
  const raw = config.totpEncryptionKey;
  if (!raw) throw new Error("TOTP_ENCRYPTION_KEY is not configured for CAPTYN WiFi admin login.");
  const key = /^[a-fA-F0-9]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOTP_ENCRYPTION_KEY must be 32 bytes.");
  return key;
}

function decryptTotpSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid TOTP secret payload.");

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

async function consumeBackupCode(input: string, hashedCodes: string[] = []) {
  const normalized = normalizeBackupCode(input);
  for (let index = 0; index < hashedCodes.length; index += 1) {
    const hashed = hashedCodes[index];
    if (await bcrypt.compare(normalized, hashed)) {
      return { matched: true, remaining: hashedCodes.filter((_code, i) => i !== index) };
    }
  }
  return { matched: false, remaining: hashedCodes };
}

export function createAdminSession(user: Pick<AdminUserRow, "id" | "email" | "name" | "isAdmin">) {
  const now = Math.floor(Date.now() / 1000);
  const payload: WifiAdminSession = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: resolveAdminRole(user),
    iat: now,
    exp: now + config.adminSessionMaxAgeSeconds
  };
  const encoded = base64url(JSON.stringify(payload));
  return { token: `${encoded}.${sign(encoded)}`, payload };
}

function createTrustedDeviceToken(user: Pick<AdminUserRow, "id" | "email">) {
  const now = Math.floor(Date.now() / 1000);
  const payload: WifiTrustedDevice = {
    scope: "wifi_admin_trusted_device",
    sub: user.id,
    email: normalizeEmail(user.email),
    iat: now,
    exp: now + config.adminTrustedDeviceMaxAgeSeconds
  };
  const encoded = base64url(JSON.stringify(payload));
  return { token: `${encoded}.${sign(encoded)}`, payload };
}

function verifyTrustedDeviceToken(token: string | null | undefined): WifiTrustedDevice | null {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  const expected = sign(encoded);
  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }

  const payload = parseBase64urlJson<WifiTrustedDevice>(encoded);
  if (!payload || payload.scope !== "wifi_admin_trusted_device" || !payload.sub || !payload.email || !payload.exp) {
    return null;
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function trustedDeviceMatches(token: string | null | undefined, user: Pick<AdminUserRow, "id" | "email">) {
  const trustedDevice = verifyTrustedDeviceToken(token);
  return Boolean(
    trustedDevice &&
    trustedDevice.sub === user.id &&
    normalizeEmail(trustedDevice.email) === normalizeEmail(user.email)
  );
}

export function verifyAdminSessionToken(token: string | null | undefined): WifiAdminSession | null {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  const expected = sign(encoded);
  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }

  const payload = parseBase64urlJson<WifiAdminSession>(encoded);
  if (!payload || !payload.sub || !payload.email || !payload.exp) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (payload.role !== "admin" && payload.role !== "root_admin") return null;
  return payload;
}

export async function verifyActiveAdminSessionToken(token: string | null | undefined): Promise<WifiAdminSession | null> {
  const session = verifyAdminSessionToken(token);
  if (!session) return null;

  const user = await readAdminUser(session.email);
  if (!user || user.id !== session.sub || normalizeEmail(user.email) !== normalizeEmail(session.email)) return null;
  if (user.status !== "active" || !user.isAdmin || !user.emailVerified) return null;
  if (!config.adminPasswordOnlyLogin && (!user.twoFactorEnabled || !user.twoFactorSecret)) return null;

  return {
    ...session,
    email: user.email,
    name: user.name,
    role: resolveAdminRole(user)
  };
}

function adminSessionResponse(user: AdminUserRow, trustedDeviceToken: ReturnType<typeof createTrustedDeviceToken> | null = null) {
  const session = createAdminSession(user);
  return {
    sessionToken: session.token,
    expiresAt: new Date(session.payload.exp * 1000).toISOString(),
    trustedDeviceToken: trustedDeviceToken?.token ?? null,
    trustedDeviceExpiresAt: trustedDeviceToken ? new Date(trustedDeviceToken.payload.exp * 1000).toISOString() : null,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: session.payload.role
    }
  };
}

export async function restoreCaptynAdminTrustedSession(input: z.infer<typeof trustedSessionSchema>) {
  const trustedDevice = verifyTrustedDeviceToken(input.trustedDeviceToken);
  if (!trustedDevice) throw new Error("Trusted device expired. Please sign in again.");

  const user = await readAdminUser(trustedDevice.email);
  if (!user || user.id !== trustedDevice.sub || normalizeEmail(user.email) !== normalizeEmail(trustedDevice.email)) {
    throw new Error("Trusted device expired. Please sign in again.");
  }
  if (user.status !== "active") throw new Error("Your account is not active. Please contact support.");
  if (!user.isAdmin) throw new Error("Access denied. Admin privileges required.");
  if (!user.emailVerified) throw new Error("Admin account email must be verified before sign-in.");
  if (config.adminPasswordOnlyLogin) return adminSessionResponse(user);
  if (!user.twoFactorEnabled) throw new Error("ADMIN_MFA_SETUP_REQUIRED");

  return adminSessionResponse(user, createTrustedDeviceToken(user));
}

async function readAdminUser(email: string) {
  const db = getAdminDb();
  const rows = await db.$queryRaw<AdminUserRow[]>`
    SELECT id, email, name, "passwordHash", "isAdmin", "isPro", status::text AS status,
           "emailVerified", "twoFactorEnabled", "twoFactorSecret", "twoFactorBackupCodes",
           "twoFactorFailedAttempts", "twoFactorLockedUntil", "twoFactorMethod"
    FROM "User"
    WHERE lower(email) = lower(${email})
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function resetMfaFailures(userId: string, remainingBackupCodes: string[] | null = null) {
  const db = getAdminDb();
  if (remainingBackupCodes) {
    await db.$executeRaw`
      UPDATE "User"
      SET "twoFactorFailedAttempts" = 0,
          "twoFactorLockedUntil" = NULL,
          "lastTwoFactorAt" = NOW(),
          "twoFactorBackupCodes" = ${remainingBackupCodes}
      WHERE id = ${userId}
    `;
    return;
  }

  await db.$executeRaw`
    UPDATE "User"
    SET "twoFactorFailedAttempts" = 0,
        "twoFactorLockedUntil" = NULL,
        "lastTwoFactorAt" = NOW()
    WHERE id = ${userId}
  `;
}

async function recordMfaFailure(user: AdminUserRow) {
  const failedAttempts = (user.twoFactorFailedAttempts ?? 0) + 1;
  const lockoutUntil = failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
  const db = getAdminDb();
  await db.$executeRaw`
    UPDATE "User"
    SET "twoFactorFailedAttempts" = ${failedAttempts},
        "twoFactorLockedUntil" = ${lockoutUntil}
    WHERE id = ${user.id}
  `;
}

export async function authenticateCaptynAdmin(input: z.infer<typeof adminLoginSchema>) {
  const email = normalizeEmail(input.email);
  const user = await readAdminUser(email);
  if (!user) {
    await bcrypt.compare(input.password, DUMMY_PASSWORD_HASH).catch(() => false);
    throw new Error("Invalid email or password");
  }

  if (user.status !== "active") throw new Error("Your account is not active. Please contact support.");
  if (!user.passwordHash) throw new Error("Admin account setup incomplete. Please reset your password.");

  const validPassword = await bcrypt.compare(input.password, user.passwordHash);
  if (!validPassword) throw new Error("Invalid email or password");
  if (!user.isAdmin) throw new Error("Access denied. Admin privileges required.");
  if (!user.emailVerified) throw new Error("Admin account email must be verified before sign-in.");
  if (config.adminPasswordOnlyLogin) return adminSessionResponse(user);
  if (!user.twoFactorEnabled) throw new Error("ADMIN_MFA_SETUP_REQUIRED");
  if (!user.twoFactorSecret) throw new Error("Two-factor authentication is not configured. Contact support.");

  const now = new Date();
  if (user.twoFactorLockedUntil && user.twoFactorLockedUntil > now) {
    throw new Error("Two-factor authentication is locked. Try again later.");
  }

  const trustedDeviceAccepted = trustedDeviceMatches(input.trustedDeviceToken, user);
  const twoFactorCode = input.twoFactorCode?.trim() || "";
  const backupCode = input.backupCode?.trim() || "";

  let remainingBackupCodes: string[] | null = null;
  if (!trustedDeviceAccepted) {
    if (!twoFactorCode && !backupCode) throw new Error("TWO_FACTOR_REQUIRED");

    let mfaVerified = false;

    if (twoFactorCode) {
      const secret = decryptTotpSecret(user.twoFactorSecret);
      mfaVerified = speakeasy.totp.verify({ secret, encoding: "base32", token: twoFactorCode, window: 2 });
    }

    if (!mfaVerified && backupCode) {
      const backup = await consumeBackupCode(backupCode, user.twoFactorBackupCodes ?? []);
      mfaVerified = backup.matched;
      if (backup.matched) remainingBackupCodes = backup.remaining;
    }

    if (!mfaVerified) {
      await recordMfaFailure(user);
      throw new Error("Invalid two-factor code");
    }

    await resetMfaFailures(user.id, remainingBackupCodes);
  }

  const trustedDevice = input.trustDevice || trustedDeviceAccepted ? createTrustedDeviceToken(user) : null;
  return adminSessionResponse(user, trustedDevice);
}
