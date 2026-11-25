import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { sendSms } from "./sms.js";

// Customer accounts. A phone is confirmed once by an SMS code; after that
// the session lets the customer see and manage everything on that phone
// ("My WiFi"). Separately, phone + device code signs a device into a
// package without SMS, locked per phone after repeated wrong codes.

export const SMS_CODE_TTL_MS = 10 * 60 * 1000;
export const SMS_CODE_MAX_ATTEMPTS = 5;
export const SESSION_TTL_MS = 180 * 24 * 3600 * 1000;
// Sends per phone: 3 in 15 minutes, 8 a day.
export const SMS_SEND_LIMITS = [{ windowMs: 15 * 60 * 1000, max: 3 }, { windowMs: 24 * 3600 * 1000, max: 8 }];
// Device-code sign-in: 5 wrong codes in 15 minutes locks that phone for the rest of the window.
export const CODE_SIGN_IN_LOCK = { windowMs: 15 * 60 * 1000, maxFailures: 5 };

export class AccountError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) { super(message); }
}

const hmac = (value: string) => crypto.createHmac("sha256", config.adminSessionSecret).update(value).digest("hex");
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export function generateSmsCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function smsCodeHash(phone: string, code: string) {
  return hmac(`sms:${phone}:${code}`);
}

// Pure: is another SMS allowed, given the times of earlier sends?
export function smsSendAllowed(previousSends: Date[], now: Date) {
  return SMS_SEND_LIMITS.every((limit) => previousSends.filter((at) => now.getTime() - at.getTime() < limit.windowMs).length < limit.max);
}

// Pure: failed device-code attempts since the last success, inside the window.
export function codeSignInLocked(attempts: Array<{ ok: boolean; at: Date }>, now: Date) {
  const recent = attempts
    .filter((a) => now.getTime() - a.at.getTime() < CODE_SIGN_IN_LOCK.windowMs)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const lastOk = recent.map((a) => a.ok).lastIndexOf(true);
  return recent.slice(lastOk + 1).filter((a) => !a.ok).length >= CODE_SIGN_IN_LOCK.maxFailures;
}

export async function startPhoneVerification(prisma: PrismaClient, phone: string, deviceMac: string | null, now = new Date()) {
  const recent = await prisma.wifiPhoneVerification.findMany({
    where: { phone, createdAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000) } },
    select: { createdAt: true }
  });
  if (!smsSendAllowed(recent.map((r) => r.createdAt), now)) {
    throw new AccountError("Too many codes sent to this number. Wait a few minutes, then try again.", 429, "sms_limit");
  }
  const code = generateSmsCode();
  const record = await prisma.wifiPhoneVerification.create({
    data: { phone, codeHash: smsCodeHash(phone, code), deviceMac, expiresAt: new Date(now.getTime() + SMS_CODE_TTL_MS) }
  });
  try {
    await sendSms(phone, `${code} is your CAPTYN WiFi code. It expires in 10 minutes. Don't share it.`);
  } catch (error) {
    await prisma.wifiPhoneVerification.delete({ where: { id: record.id } }).catch(() => {});
    console.error("Sign-in SMS failed:", error instanceof Error ? error.message : error);
    throw new AccountError("We couldn't send the code just now. Try again in a minute.", 503, "sms_failed");
  }
  return { expiresInSeconds: SMS_CODE_TTL_MS / 1000 };
}

export async function verifyPhoneCode(prisma: PrismaClient, phone: string, code: string, deviceMac: string | null, now = new Date()) {
  const pending = await prisma.wifiPhoneVerification.findFirst({
    where: { phone, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" }
  });
  if (!pending) throw new AccountError("That code has expired. Ask for a new one.", 400, "code_expired");
  if (pending.attempts >= SMS_CODE_MAX_ATTEMPTS) throw new AccountError("Too many wrong tries. Ask for a new code.", 429, "code_locked");
  if (pending.codeHash !== smsCodeHash(phone, code.trim())) {
    await prisma.wifiPhoneVerification.update({ where: { id: pending.id }, data: { attempts: { increment: 1 } } });
    throw new AccountError("That code isn't right. Check the SMS and try again.", 400, "code_wrong");
  }
  await prisma.wifiPhoneVerification.update({ where: { id: pending.id }, data: { consumedAt: now } });
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.wifiAccountSession.create({
    data: { phone, tokenHash: sha256(token), deviceMac, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) }
  });
  return { token, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) };
}

export async function accountFromToken(prisma: PrismaClient, token: string | undefined, now = new Date()) {
  if (!token) return null;
  const session = await prisma.wifiAccountSession.findUnique({ where: { tokenHash: sha256(token) } });
  if (!session || session.revokedAt || session.expiresAt <= now) return null;
  if (now.getTime() - session.lastUsedAt.getTime() > 3600 * 1000) {
    await prisma.wifiAccountSession.update({ where: { id: session.id }, data: { lastUsedAt: now } }).catch(() => {});
  }
  return session;
}

export async function revokeAccountToken(prisma: PrismaClient, token: string) {
  await prisma.wifiAccountSession.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function recordCodeSignIn(prisma: PrismaClient, phone: string, ok: boolean, deviceMac: string | null) {
  await prisma.wifiAccountSignInAttempt.create({ data: { phone, ok, deviceMac } });
}

export async function codeSignInIsLocked(prisma: PrismaClient, phone: string, now = new Date()) {
  const attempts = await prisma.wifiAccountSignInAttempt.findMany({
    where: { phone, at: { gte: new Date(now.getTime() - CODE_SIGN_IN_LOCK.windowMs) } },
    select: { ok: true, at: true }
  });
  return codeSignInLocked(attempts, now);
}
