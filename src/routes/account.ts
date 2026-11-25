import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { bodyFieldKey, clientRateLimit, ipKey } from "../middleware/rateLimitGuard.js";
import { formatDarajaMsisdn } from "../services/mpesa.js";
import { normalizeDeviceMac } from "../services/radiusProjection.js";
import { ensureConnectCode, normalizeConnectCode } from "../services/connectCode.js";
import { deviceCap, publicDevice } from "../services/deviceLedger.js";
import { forgetHotspotDeviceForUser, kickHotspotDevice } from "../services/routeros.js";
import {
  AccountError, accountFromToken, codeSignInIsLocked, recordCodeSignIn, revokeAccountToken,
  startPhoneVerification, verifyPhoneCode
} from "../services/account.js";
import { maskPhone } from "../services/clientTrace.js";

// Customer accounts ("My WiFi"). Limits are per phone, not per IP: every
// customer reaches us through the site's one public IP.
export const accountRouter = Router();

const phoneLimit = (name: string, max: number) => clientRateLimit({
  name, windowMs: 15 * 60 * 1000, max, key: bodyFieldKey("phone"), message: "Too many tries for this number. Wait a few minutes."
});
const siteLimit = clientRateLimit({ name: "wifi-account-site", windowMs: 60 * 1000, max: 120, key: ipKey, message: "Too many requests. Try again shortly." });

const ACCOUNT_HEADER = "x-captyn-wifi-account";
const activeAccessWhere = (now: Date) => ({
  status: "active" as const,
  OR: [{ expiresAt: { gt: now } }, { outagePausedAt: { not: null } }, { promoPausedAt: { not: null } }]
});

function phoneFrom(raw: unknown) {
  const phone = formatDarajaMsisdn(typeof raw === "string" ? raw : "");
  if (!phone) throw new AccountError("Enter a Safaricom or Airtel number, e.g. 0712 345 678.", 400, "phone_invalid");
  return phone;
}

function sendAccountError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof AccountError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return res.status(400).json({ error: "Check the details and try again." });
  return next(error);
}

async function requireAccount(req: Request, res: Response) {
  const session = await accountFromToken(prisma, req.header(ACCOUNT_HEADER) || undefined);
  if (!session) {
    res.status(401).json({ error: "Confirm your phone number again.", code: "account_signed_out" });
    return null;
  }
  return session;
}

accountRouter.post("/phone/start", siteLimit, phoneLimit("wifi-account-sms", 6), async (req, res, next) => {
  try {
    const phone = phoneFrom(req.body?.phone);
    const deviceMac = normalizeDeviceMac(typeof req.body?.deviceMac === "string" ? req.body.deviceMac : null);
    const result = await startPhoneVerification(prisma, phone, deviceMac);
    return res.status(202).json({ data: { sentTo: maskPhone(phone), ...result } });
  } catch (error) {
    return sendAccountError(error, res, next);
  }
});

accountRouter.post("/phone/verify", siteLimit, phoneLimit("wifi-account-verify", 12), async (req, res, next) => {
  try {
    const phone = phoneFrom(req.body?.phone);
    const code = z.string().trim().regex(/^\d{6}$/).parse(req.body?.code);
    const deviceMac = normalizeDeviceMac(typeof req.body?.deviceMac === "string" ? req.body.deviceMac : null);
    const { token, expiresAt } = await verifyPhoneCode(prisma, phone, code, deviceMac);
    return res.json({ data: { token, expiresAt, phone: maskPhone(phone) } });
  } catch (error) {
    return sendAccountError(error, res, next);
  }
});

accountRouter.post("/sign-out", siteLimit, async (req, res) => {
  const token = req.header(ACCOUNT_HEADER);
  if (token) await revokeAccountToken(prisma, token).catch(() => {});
  return res.status(204).end();
});

// Phone + device code: signs this device into that package (no SMS needed).
// Returns the package login for the portal's usual server sign-in.
accountRouter.post("/code-sign-in", siteLimit, phoneLimit("wifi-account-code", 10), async (req, res, next) => {
  try {
    const phone = phoneFrom(req.body?.phone);
    const code = normalizeConnectCode(String(req.body?.code ?? ""));
    const deviceMac = normalizeDeviceMac(typeof req.body?.deviceMac === "string" ? req.body.deviceMac : null);
    if (await codeSignInIsLocked(prisma, phone)) {
      throw new AccountError("Too many wrong codes for this number. Wait 15 minutes, or confirm your number by SMS.", 429, "code_sign_in_locked");
    }
    const entitlement = code
      ? await prisma.wifiEntitlement.findFirst({ where: { customerPhone: phone, connectCode: code, ...activeAccessWhere(new Date()) } })
      : null;
    await recordCodeSignIn(prisma, phone, Boolean(entitlement), deviceMac);
    if (!entitlement) throw new AccountError("That number and device code don't match an active package.", 404, "code_no_match");
    return res.json({
      data: { username: entitlement.username, password: entitlement.cleartextSecret, expiresAt: entitlement.expiresAt, deviceLimit: entitlement.deviceLimit }
    });
  } catch (error) {
    return sendAccountError(error, res, next);
  }
});

// My WiFi: every active package on this phone, its devices and what's left.
accountRouter.get("/me", siteLimit, async (req, res, next) => {
  try {
    const session = await requireAccount(req, res);
    if (!session) return;
    const now = new Date();
    const entitlements = await prisma.wifiEntitlement.findMany({
      where: { customerPhone: session.phone, ...activeAccessWhere(now) },
      include: { plan: { select: { name: true } }, devices: { orderBy: { addedAt: "asc" } } },
      orderBy: { expiresAt: "desc" }
    });
    const macs = [...new Set(entitlements.flatMap((e) => e.devices.map((d) => d.deviceMac)))];
    const registry = macs.length
      ? await prisma.wifiDevice.findMany({ where: { mac: { in: macs } }, select: { mac: true, online: true, hostName: true, lastSeenAt: true } })
      : [];
    const seen = new Map(registry.map((d) => [d.mac, d]));
    const packages = await Promise.all(entitlements.map(async (e) => {
      const cap = deviceCap(e);
      return {
        id: e.id,
        name: e.plan?.name ?? "Package",
        expiresAt: e.expiresAt,
        paused: Boolean(e.outagePausedAt || e.promoPausedAt),
        deviceLimit: e.deviceLimit,
        deviceCap: cap,
        switchesLeft: Math.max(0, cap - e.devices.length),
        deviceCode: await ensureConnectCode(prisma, e),
        devices: e.devices.map((d) => {
          const fact = seen.get(d.deviceMac);
          return { ...publicDevice(d), online: Boolean(fact?.online) && !d.signedOutAt, name: fact?.hostName ?? null, lastSeenAt: fact?.lastSeenAt ?? d.lastSeenAt };
        }),
        // The generated login, kept for the router page as a last resort.
        login: { username: e.username, password: e.cleartextSecret }
      };
    }));
    return res.json({ data: { phone: maskPhone(session.phone), packages } });
  } catch (error) {
    return sendAccountError(error, res, next);
  }
});

// Sign a device out of one of this phone's packages (it keeps its slot, as
// everywhere else; switchesLeft says what's still possible).
accountRouter.post("/devices/sign-out", siteLimit, async (req, res, next) => {
  try {
    const session = await requireAccount(req, res);
    if (!session) return;
    const packageId = z.string().min(1).parse(req.body?.packageId);
    const mac = normalizeDeviceMac(typeof req.body?.deviceMac === "string" ? req.body.deviceMac : null);
    if (!mac) throw new AccountError("Choose a device.", 400);
    const entitlement = await prisma.wifiEntitlement.findFirst({ where: { id: packageId, customerPhone: session.phone, ...activeAccessWhere(new Date()) } });
    if (!entitlement) throw new AccountError("That package isn't on your number.", 404);
    const updated = await prisma.wifiEntitlementDevice.updateMany({ where: { entitlementId: entitlement.id, deviceMac: mac }, data: { signedOutAt: new Date() } });
    if (updated.count === 0) throw new AccountError("That device isn't on this package.", 404);
    const forgot = await forgetHotspotDeviceForUser(mac, entitlement.username);
    if (forgot.error) console.warn(`Account sign-out cookie removal ${mac} did not complete: ${forgot.error}`);
    await kickHotspotDevice(mac);
    if (entitlement.deviceMac === mac) await prisma.wifiEntitlement.update({ where: { id: entitlement.id }, data: { deviceMac: null } });
    return res.json({ data: { signedOut: true } });
  } catch (error) {
    return sendAccountError(error, res, next);
  }
});
