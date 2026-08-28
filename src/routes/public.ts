import crypto from "node:crypto";
import { Router } from "express";
import type { Prisma, WifiPaymentIntent, WifiPlan } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { formatDarajaMsisdn, getMpesaStatus, initiateWifiStkPush, isSuccessfulStkQuery, queryWifiStkPush } from "../services/mpesa.js";
import { buildRadiusProjection, createRadiusSecret, normalizeDeviceMac, normalizeWifiUsername } from "../services/radiusProjection.js";
import { applyRadiusProjectionRows } from "../services/radiusSqlApply.js";
import { bodyFieldKey, clientRateLimit, ipKey } from "../middleware/rateLimitGuard.js";

export const publicRouter = Router();

const publicFreeAccessLimit = clientRateLimit({
  name: "wifi-public-free-access",
  windowMs: 15 * 60 * 1000,
  max: 20,
  key: ipKey,
  message: "Too many access attempts. Try again shortly."
});

const publicCredentialLinkLimit = clientRateLimit({
  name: "wifi-public-link-device",
  windowMs: 15 * 60 * 1000,
  max: 30,
  key: ipKey,
  message: "Too many reconnect attempts. Try again shortly."
});

const publicReceiptLookupLimit = clientRateLimit({
  name: "wifi-public-receipt-lookup",
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => `${ipKey(req)}:${bodyFieldKey("receipt")(req)}`,
  message: "Too many receipt lookups. Try again shortly."
});

const publicPaymentIpLimit = clientRateLimit({
  name: "wifi-public-payment",
  windowMs: 60 * 1000,
  max: 12,
  key: ipKey,
  message: "Too many payment attempts. Try again shortly."
});

// "captyn_housing"-sourced plans exist only to record housing-forwarded
// resident payments, and stay out of this list. "captyn_dynamic" plans are
// the traffic-priced rotating offer from DynamicPlanEngine -- purchasable
// like any admin-curated plan, just machine-managed.
const PUBLICLY_PURCHASABLE_SOURCES = ["captyn_admin", "captyn_dynamic"];

const stkRequestSchema = z.object({
  planId: z.string().min(1),
  phone: z.string().min(7),
  deviceMac: z.string().trim().optional().nullable()
});

const freeAccessSchema = z.object({
  planId: z.string().min(1),
  deviceMac: z.string().trim().optional().nullable()
});

type CallbackMetadata = {
  Item?: Array<{ Name?: string; Value?: string | number }>;
};

type StkCallback = {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResultCode?: number;
  ResultDesc?: string;
  CallbackMetadata?: CallbackMetadata;
};

function sourceReference() {
  return `wifi-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function freeAccessUsername(deviceMac: string | null) {
  const compactMac = deviceMac?.replace(/[^A-F0-9]/gi, "").toLowerCase();
  if (compactMac) return `free-${compactMac}`;
  return `free-${crypto.randomBytes(6).toString("hex")}`;
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
    )
  );
}

const MPESA_FAILURE_MESSAGES: Record<number, string> = {
  1: "M-PESA said the balance is insufficient for this payment.",
  1032: "The M-PESA prompt was cancelled or ignored. Tap Pay Now to try again.",
  1037: "The M-PESA prompt could not reach your phone in time. Check your signal and dial *334# to clear any pending M-PESA session, then try again.",
  9999: "M-PESA had a temporary error sending the prompt. Please try again in a moment."
};

function mpesaFailureReason(rawPayload: unknown): string | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const callback = (rawPayload as { Body?: { stkCallback?: { ResultCode?: number; ResultDesc?: string } } }).Body
    ?.stkCallback;
  if (!callback || callback.ResultCode === undefined || callback.ResultCode === 0) return null;
  return MPESA_FAILURE_MESSAGES[callback.ResultCode] ?? callback.ResultDesc ?? "Payment did not complete.";
}

// Sums every outage credit ever applied to this entitlement (see
// outageCredit.ts's resumePausedEntitlements), so the portal can tell a
// customer how much time they've gotten back from past network outages —
// on top of whatever's currently paused (outagePausedAt on the entitlement
// itself), which hasn't been credited yet since it hasn't resumed.
async function sumOutageCreditSeconds(entitlementId: string): Promise<number> {
  const result = await prisma.wifiOutageCredit.aggregate({
    where: { entitlementId },
    _sum: { creditedSeconds: true }
  });
  return result._sum.creditedSeconds ?? 0;
}

async function publicEntitlement(entitlement: {
  id: string;
  username: string;
  cleartextSecret: string;
  expiresAt: Date;
  deviceLimit: number;
  rateLimit: string | null;
  outagePausedAt: Date | null;
}) {
  const totalCreditedSeconds = await sumOutageCreditSeconds(entitlement.id);
  return {
    username: entitlement.username,
    password: entitlement.cleartextSecret,
    expiresAt: entitlement.expiresAt,
    deviceLimit: entitlement.deviceLimit,
    rateLimit: entitlement.rateLimit,
    pausedSince: entitlement.outagePausedAt,
    totalCreditedSeconds
  };
}

// An entitlement paused for outage credit (see outageCredit.ts) keeps its
// pre-outage expiresAt until a reconnect is actually detected -- crediting
// only happens after that, not before -- so a customer paused longer than
// their remaining balance would otherwise look expired here well before the
// backend has given up on them. outagePausedAt being set means the clock is
// frozen, regardless of how stale expiresAt has become.
function activeAccessWhere(now: Date): Prisma.WifiEntitlementWhereInput {
  return { status: "active", OR: [{ expiresAt: { gt: now } }, { outagePausedAt: { not: null } }] };
}

async function findCurrentEntitlementForUsername(username: string, at = new Date()) {
  const active = await prisma.wifiEntitlement.findFirst({
    where: { username, ...activeAccessWhere(at) },
    orderBy: { expiresAt: "desc" }
  });
  if (active) return active;

  return prisma.wifiEntitlement.findFirst({
    where: { username },
    orderBy: { expiresAt: "desc" }
  });
}

function metadataValue(metadata: CallbackMetadata | undefined, name: string) {
  const item = metadata?.Item?.find((entry) => entry.Name === name);
  return item?.Value;
}

function metadataNumber(metadata: CallbackMetadata | undefined, name: string) {
  const value = metadataValue(metadata, name);
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function readStkCallback(body: unknown): StkCallback | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { Body?: { stkCallback?: StkCallback } };
  return record.Body?.stkCallback ?? null;
}

function rawPayloadMerchantRequestId(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const value = (rawPayload as { MerchantRequestID?: unknown }).MerchantRequestID;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function activatePaymentIntent(intent: WifiPaymentIntent, confirmedAt = new Date()) {
  return prisma.$transaction(async (tx) => {
    const paymentIntent = await tx.wifiPaymentIntent.findUnique({
      where: { id: intent.id },
      include: { site: true, plan: true, entitlement: { include: { projection: true } } }
    });
    if (!paymentIntent) throw new Error("Payment intent not found");
    if (paymentIntent.entitlement) {
      const updatedIntent = await tx.wifiPaymentIntent.update({
        where: { id: paymentIntent.id },
        data: { status: "activated", confirmedAt: paymentIntent.confirmedAt ?? confirmedAt },
        include: { site: true, plan: true }
      });
      return {
        intent: updatedIntent,
        entitlement: paymentIntent.entitlement,
        projection: paymentIntent.entitlement.projection,
        alreadyProcessed: true,
        extended: false
      };
    }

    const startsAt = confirmedAt;
    const username = normalizeWifiUsername(paymentIntent.customerPhone);

    // If this phone already has valid, unexpired access, extend it in place
    // instead of creating a second entitlement. RADIUS identity is derived
    // from the phone number, so a second entitlement would silently overwrite
    // (and, on its own earlier expiry, delete) this one's radcheck/radreply
    // rows even though this one is still supposed to be valid.
    const existingActive = await tx.wifiEntitlement.findFirst({
      where: { username, ...activeAccessWhere(startsAt) },
      include: { projection: true },
      orderBy: { expiresAt: "desc" }
    });

    if (existingActive) {
      // Extending only ever adds time — it must never touch the plan/rate
      // limit/device limit the customer already has. A cheap top-up (e.g. a
      // 30-minute Flash pass) bought while a longer, better-tier entitlement
      // (e.g. a Weekly pass) is still active must not downgrade that
      // customer's speed or device limit to the top-up's tier.
      const extendedExpiresAt = new Date(existingActive.expiresAt.getTime() + paymentIntent.plan.durationSeconds * 1000);
      const extendedEntitlement = await tx.wifiEntitlement.update({
        where: { id: existingActive.id },
        // A fresh payment reactivates RADIUS right now (below), so an
        // outage pause on this entitlement is moot -- clear it here rather
        // than leaving it for the outage sweep to later re-credit and
        // re-apply a projection this payment has already superseded.
        data: { expiresAt: extendedExpiresAt, outagePausedAt: null, outagePauseCause: null }
      });

      const extendedProjection = buildRadiusProjection({
        entitlementId: extendedEntitlement.id,
        phone: paymentIntent.customerPhone,
        username: extendedEntitlement.username,
        password: extendedEntitlement.cleartextSecret,
        deviceMac: extendedEntitlement.deviceMac,
        expiresAt: extendedExpiresAt,
        durationSeconds: Math.max(60, Math.round((extendedExpiresAt.getTime() - startsAt.getTime()) / 1000)),
        rateLimit: existingActive.rateLimit,
        deviceLimit: existingActive.deviceLimit
      });

      // Apply synchronously (see voucherIssuance.ts for why) — auto-connect
      // fires ~1.5s after payment confirmation, well inside the async
      // worker's poll gap.
      await applyRadiusProjectionRows(tx, extendedProjection.username, extendedProjection.checkItems, extendedProjection.replyItems);
      const radiusProjection = existingActive.projection
        ? await tx.wifiRadiusProjection.update({
            where: { id: existingActive.projection.id },
            data: {
              checkItems: extendedProjection.checkItems,
              replyItems: extendedProjection.replyItems,
              status: "applied",
              appliedAt: startsAt,
              lastError: null
            }
          })
        : await tx.wifiRadiusProjection.create({
            data: {
              entitlementId: extendedEntitlement.id,
              username: extendedProjection.username,
              checkItems: extendedProjection.checkItems,
              replyItems: extendedProjection.replyItems,
              status: "applied",
              appliedAt: startsAt
            }
          });

      const updatedIntent = await tx.wifiPaymentIntent.update({
        where: { id: paymentIntent.id },
        data: { status: "activated", confirmedAt: startsAt },
        include: { site: true, plan: true }
      });

      return { intent: updatedIntent, entitlement: extendedEntitlement, projection: radiusProjection, alreadyProcessed: false, extended: true };
    }

    const expiresAt = new Date(startsAt.getTime() + paymentIntent.plan.durationSeconds * 1000);
    const password = createRadiusSecret();

    const entitlement = await tx.wifiEntitlement.create({
      data: {
        siteId: paymentIntent.siteId,
        planId: paymentIntent.planId,
        paymentIntentId: paymentIntent.id,
        customerPhone: paymentIntent.customerPhone,
        username,
        cleartextSecret: password,
        deviceMac: paymentIntent.deviceMac,
        status: "active",
        startsAt,
        expiresAt,
        deviceLimit: paymentIntent.plan.deviceLimit,
        rateLimit: paymentIntent.plan.rateLimit,
        acctInterimSeconds: config.defaultAcctInterimSeconds
      }
    });

    const projection = buildRadiusProjection({
      entitlementId: entitlement.id,
      phone: paymentIntent.customerPhone,
      username,
      password,
      deviceMac: paymentIntent.deviceMac,
      expiresAt,
      durationSeconds: paymentIntent.plan.durationSeconds,
      rateLimit: paymentIntent.plan.rateLimit,
      deviceLimit: paymentIntent.plan.deviceLimit
    });

    // Apply synchronously — see voucherIssuance.ts for why (auto-connect
    // fires seconds after payment confirmation, inside the worker's poll gap).
    await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
    const radiusProjection = await tx.wifiRadiusProjection.create({
      data: {
        entitlementId: entitlement.id,
        username: projection.username,
        checkItems: projection.checkItems,
        replyItems: projection.replyItems,
        status: "applied",
        appliedAt: startsAt
      }
    });

    const updatedIntent = await tx.wifiPaymentIntent.update({
      where: { id: paymentIntent.id },
      data: { status: "activated", confirmedAt: startsAt },
      include: { site: true, plan: true }
    });

    return { intent: updatedIntent, entitlement, projection: radiusProjection, alreadyProcessed: false, extended: false };
  });
}

async function activateFreePlan(plan: WifiPlan, deviceMac: string | null) {
  const startsAt = new Date();
  const username = freeAccessUsername(deviceMac);
  const sourceRef = sourceReference();

  return prisma.$transaction(async (tx) => {
    // "CAPTYN Welcome" is meant to be a one-time-ever welcome offer per
    // device, not a daily freebie -- so this blocks on *any* prior claim
    // for this device, active or long expired, not just a currently-active
    // one. Checked inside the transaction (not in the route handler) so two
    // near-simultaneous claims from the same device -- e.g. a retried
    // request -- can't both slip through before either commits.
    const priorFreeClaim = await tx.wifiEntitlement.findFirst({
      where: { username },
      orderBy: { expiresAt: "desc" }
    });
    if (priorFreeClaim) {
      return { blocked: true as const, existingActive: priorFreeClaim };
    }

    const intent = await tx.wifiPaymentIntent.create({
      data: {
        siteId: plan.siteId,
        planId: plan.id,
        source: "captyn_wifi_free",
        sourceReference: sourceRef,
        customerPhone: username,
        deviceMac,
        amountKsh: 0,
        provider: "free",
        status: "activated",
        confirmedAt: startsAt
      }
    });

    const expiresAt = new Date(startsAt.getTime() + plan.durationSeconds * 1000);
    const password = createRadiusSecret();
    const entitlement = await tx.wifiEntitlement.create({
      data: {
        siteId: plan.siteId,
        planId: plan.id,
        paymentIntentId: intent.id,
        customerPhone: username,
        username,
        cleartextSecret: password,
        deviceMac,
        status: "active",
        startsAt,
        expiresAt,
        deviceLimit: plan.deviceLimit,
        rateLimit: plan.rateLimit,
        acctInterimSeconds: config.defaultAcctInterimSeconds
      }
    });

    const projection = buildRadiusProjection({
      entitlementId: entitlement.id,
      phone: username,
      username,
      password,
      deviceMac,
      expiresAt,
      durationSeconds: plan.durationSeconds,
      rateLimit: plan.rateLimit,
      deviceLimit: plan.deviceLimit
    });

    await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
    const radiusProjection = await tx.wifiRadiusProjection.create({
      data: {
        entitlementId: entitlement.id,
        username: projection.username,
        checkItems: projection.checkItems,
        replyItems: projection.replyItems,
        status: "applied",
        appliedAt: startsAt
      }
    });

    return { blocked: false as const, intent, entitlement, projection: radiusProjection, extended: false };
  });
}

publicRouter.get("/sites", async (_req, res, next) => {
  try {
    const sites = await prisma.wifiSite.findMany({
      orderBy: { name: "asc" },
      include: {
        plans: {
          // Once a paid captyn_admin plan has a captyn_dynamic mirror, the
          // mirror is what's shown -- the baseline becomes a reference rate
          // card edited via the admin Packages UI, not a static price
          // customers buy directly. Free/promotional captyn_admin plans
          // (priceKsh 0, e.g. CAPTYN Welcome) are never mirrored and keep
          // showing as-is. manualPricing captyn_admin plans are the third
          // case: the admin pinned this price on purpose, dynamicPlanEngine
          // skips mirroring them (see maybeRotate()), so they also show as-is.
          where: {
            enabled: true,
            OR: [
              { source: "captyn_dynamic" },
              { source: "captyn_admin", priceKsh: 0 },
              { source: "captyn_admin", manualPricing: true }
            ]
          },
          orderBy: [{ featured: "desc" }, { priceKsh: "asc" }, { durationSeconds: "asc" }, { name: "asc" }]
        }
      }
    });
    return res.json({ data: toJsonSafe(sites.filter((site) => site.plans.length > 0)) });
  } catch (error) {
    return next(error);
  }
});

publicRouter.post("/access/free", publicFreeAccessLimit, async (req, res, next) => {
  try {
    const parsed = freeAccessSchema.parse(req.body);
    const plan = await prisma.wifiPlan.findFirst({
      where: { id: parsed.planId, enabled: true, source: "captyn_admin" },
      include: { site: true }
    });
    if (!plan) return res.status(404).json({ error: "WiFi package not found or disabled." });
    if (plan.priceKsh !== 0) return res.status(400).json({ error: "This package requires payment." });

    // Without a device MAC, freeAccessUsername() falls back to a random,
    // untethered "free-<random>" username -- completely bypassing per-device
    // tracking, including the one-time-ever check in activateFreePlan. That's
    // reachable by anyone who hits this endpoint without the mac= param the
    // real hotspot redirect carries -- which, since captyn.shop is a public
    // domain, isn't even limited to people on the WiFi. Free access only
    // makes sense tied to a real device, so require one.
    const deviceMac = normalizeDeviceMac(parsed.deviceMac);
    if (!deviceMac) {
      return res.status(400).json({ error: "Free access needs to come from the CAPTYN WiFi sign-in page so it can be tied to your device. Reconnect to the WiFi network and try again from there." });
    }

    const activated = await activateFreePlan(plan, deviceMac);
    if (activated.blocked) {
      return res.status(400).json({
        error: "This device already has active free WiFi access. It needs to expire before you can claim it again.",
        entitlement: toJsonSafe(await publicEntitlement(activated.existingActive))
      });
    }
    return res.status(201).json({
      data: toJsonSafe({
        id: activated.intent.id,
        status: activated.intent.status,
        sourceReference: activated.intent.sourceReference,
        amountKsh: activated.intent.amountKsh,
        site: plan.site,
        plan,
        entitlement: await publicEntitlement(activated.entitlement),
        extended: activated.extended
      })
    });
  } catch (error) {
    return next(error);
  }
});

publicRouter.get("/payments/:id", async (req, res, next) => {
  try {
    const intent = await prisma.wifiPaymentIntent.findUnique({
      where: { id: req.params.id },
      include: { site: true, plan: true, entitlement: true }
    });
    if (!intent) return res.status(404).json({ error: "Payment not found" });

    // A payment that extended an already-active entitlement (see
    // activatePaymentIntent) is never linked via WifiEntitlement.paymentIntentId
    // — that FK is already claimed by whichever payment originally created the
    // entitlement. Fall back to the customer's current active entitlement so
    // the portal still sees a completed, connectable result for this payment.
    const entitlement =
      intent.entitlement ??
      (intent.status === "activated"
        ? await prisma.wifiEntitlement.findFirst({
            where: { username: normalizeWifiUsername(intent.customerPhone), status: "active", expiresAt: { gt: new Date() } },
            orderBy: { expiresAt: "desc" }
          })
        : null);

    return res.json({
      data: toJsonSafe({
        id: intent.id,
        status: intent.status,
        sourceReference: intent.sourceReference,
        providerReference: intent.providerReference,
        receiptNumber: intent.receiptNumber,
        amountKsh: intent.amountKsh,
        site: intent.site,
        plan: intent.plan,
        entitlement: entitlement ? await publicEntitlement(entitlement) : null,
        extended: !intent.entitlement && Boolean(entitlement),
        failureReason: intent.status === "failed" ? mpesaFailureReason(intent.rawPayload) : null
      })
    });
  } catch (error) {
    return next(error);
  }
});

publicRouter.get("/entitlements/by-device/:mac", (_req, res) => {
  return res.status(410).json({
    error: "Saved-device lookup now requires this browser to have remembered the access details. Use your M-PESA receipt, voucher code, or technical login to reconnect."
  });
});

const linkDeviceSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  deviceMac: z.string().trim().min(1)
});

// Called after a successful manual login (existing username/password, voucher,
// or receipt code) so this device is remembered against the entitlement and
// can be silently reconnected next time it hits the captive portal, instead
// of prompting for credentials again.
publicRouter.post("/entitlements/link-device", publicCredentialLinkLimit, async (req, res, next) => {
  try {
    const parsed = linkDeviceSchema.parse(req.body);
    const mac = normalizeDeviceMac(parsed.deviceMac);
    if (!mac) return res.status(400).json({ error: "Device MAC required" });

    const entitlement = await prisma.wifiEntitlement.findFirst({
      where: { username: parsed.username, ...activeAccessWhere(new Date()) },
      orderBy: { createdAt: "desc" }
    });
    if (!entitlement || entitlement.cleartextSecret !== parsed.password) {
      return res.status(404).json({ error: "No matching active access record" });
    }

    if (entitlement.deviceMac !== mac) {
      await prisma.wifiEntitlement.update({ where: { id: entitlement.id }, data: { deviceMac: mac } });
    }
    return res.json({ data: { linked: true } });
  } catch (error) {
    return next(error);
  }
});

const receiptLookupSchema = z.object({
  receipt: z.string().trim().min(8).max(32),
  phone: z.string().trim().min(7)
});

publicRouter.post("/payments/lookup-by-receipt", publicReceiptLookupLimit, async (req, res, next) => {
  try {
    const parsed = receiptLookupSchema.parse(req.body);
    const receipt = parsed.receipt.toUpperCase();
    const phone = formatDarajaMsisdn(parsed.phone);
    if (!phone) return res.status(400).json({ error: "Enter the Safaricom phone number used for this payment." });

    const intent = await prisma.wifiPaymentIntent.findFirst({
      where: { receiptNumber: receipt, customerPhone: phone },
      include: { entitlement: true }
    });
    if (!intent) return res.status(404).json({ error: "No payment found for that M-PESA code." });

    const entitlement =
      intent.entitlement ??
      (intent.status === "activated" ? await findCurrentEntitlementForUsername(normalizeWifiUsername(intent.customerPhone)) : null);
    if (!entitlement) return res.status(404).json({ error: "No payment found for that M-PESA code." });
    if (entitlement.status !== "active" || (entitlement.expiresAt <= new Date() && !entitlement.outagePausedAt)) {
      return res.status(404).json({ error: "That payment's WiFi access has already expired." });
    }
    return res.json({ data: toJsonSafe(await publicEntitlement(entitlement)) });
  } catch (error) {
    return next(error);
  }
});

publicRouter.get("/entitlements/:username/status", async (req, res, next) => {
  try {
    const username = req.params.username.trim();
    if (!username) return res.status(400).json({ error: "Username required" });
    const entitlement = await findCurrentEntitlementForUsername(username);
    if (!entitlement) return res.status(404).json({ error: "Not found" });
    return res.json({ data: toJsonSafe({ status: entitlement.status, expiresAt: entitlement.expiresAt, deviceLimit: entitlement.deviceLimit }) });
  } catch (error) {
    return next(error);
  }
});

publicRouter.post("/payments/mpesa/stk", publicPaymentIpLimit, async (req, res, next) => {
  try {
    const parsed = stkRequestSchema.parse(req.body);
    const phone = formatDarajaMsisdn(parsed.phone);
    if (!phone) return res.status(400).json({ error: "Enter a valid Safaricom phone number." });

    const plan = await prisma.wifiPlan.findFirst({
      where: { id: parsed.planId, enabled: true, source: { in: PUBLICLY_PURCHASABLE_SOURCES } },
      include: { site: true }
    });
    if (!plan) return res.status(404).json({ error: "WiFi package not found or disabled." });

    const mpesa = getMpesaStatus();
    if (!mpesa.configured) return res.status(503).json({ error: "M-PESA is not configured for WiFi payments." });

    const reference = sourceReference();
    const intent = await prisma.wifiPaymentIntent.create({
      data: {
        siteId: plan.siteId,
        planId: plan.id,
        source: "captyn_wifi_portal",
        sourceReference: reference,
        customerPhone: phone,
        deviceMac: normalizeDeviceMac(parsed.deviceMac),
        amountKsh: plan.priceKsh,
        provider: "mpesa",
        status: "pending_confirmation"
      },
      include: { site: true, plan: true }
    });

    const stk = await initiateWifiStkPush({
      amount: plan.priceKsh,
      phoneNumber: phone,
      accountReference: reference.slice(0, 12),
      transactionDesc: `CAPTYN WiFi ${plan.name}`.slice(0, 64),
      callbackUrl: config.mpesa.callbackUrl
    });

    const checkoutRequestId = typeof stk.CheckoutRequestID === "string" ? stk.CheckoutRequestID : null;
    const responseCode = typeof stk.ResponseCode === "string" ? stk.ResponseCode : null;

    const updated = await prisma.wifiPaymentIntent.update({
      where: { id: intent.id },
      data: {
        providerReference: checkoutRequestId,
        status: responseCode === "0" ? "pending_confirmation" : "failed",
        rawPayload: stk as Prisma.InputJsonValue
      },
      include: { site: true, plan: true }
    });

    return res.status(201).json({
      data: toJsonSafe({
        id: updated.id,
        status: updated.status,
        sourceReference: updated.sourceReference,
        checkoutRequestId,
        customerMessage: stk.CustomerMessage || stk.ResponseDescription || "Check your phone to complete payment.",
        amountKsh: updated.amountKsh,
        site: updated.site,
        plan: updated.plan
      })
    });
  } catch (error) {
    return next(error);
  }
});

publicRouter.post("/payments/mpesa/callback", async (req, res, next) => {
  try {
    const callback = readStkCallback(req.body);
    if (!callback) return res.status(400).json({ error: "Invalid M-PESA callback" });
    const checkoutRequestId = callback.CheckoutRequestID?.trim();
    if (!checkoutRequestId) return res.status(400).json({ error: "Invalid M-PESA callback" });

    const resultCode = Number(callback.ResultCode ?? -1);
    const receipt = metadataValue(callback.CallbackMetadata, "MpesaReceiptNumber");
    const amount = metadataValue(callback.CallbackMetadata, "Amount");
    const paidAmount = metadataNumber(callback.CallbackMetadata, "Amount");
    const phone = metadataValue(callback.CallbackMetadata, "PhoneNumber");

    console.log(
      "M-PESA STK callback received: checkoutRequestId=" + checkoutRequestId +
        " resultCode=" + resultCode +
        " resultDesc=" + (callback.ResultDesc ?? "-") +
        " phone=" + (phone ?? "-") +
        " amount=" + (amount ?? "-") +
        " receipt=" + (receipt ?? "-")
    );

    const intent = await prisma.wifiPaymentIntent.findFirst({
      where: { provider: "mpesa", providerReference: checkoutRequestId },
      include: { plan: true }
    });
    if (!intent) {
      console.warn("M-PESA STK callback matched no payment intent: checkoutRequestId=" + checkoutRequestId);
      return res.json({ data: { accepted: true, matched: false } });
    }

    const expectedMerchantRequestId = rawPayloadMerchantRequestId(intent.rawPayload);
    if (expectedMerchantRequestId && callback.MerchantRequestID !== expectedMerchantRequestId) {
      console.warn("M-PESA STK callback rejected: merchant request id mismatch for checkoutRequestId=" + checkoutRequestId);
      return res.status(400).json({ error: "Invalid M-PESA callback" });
    }

    if (resultCode === 0) {
      if (paidAmount === null || Math.round(paidAmount) < intent.amountKsh) {
        await prisma.wifiPaymentIntent.update({
          where: { id: intent.id },
          data: {
            rawPayload: req.body as Prisma.InputJsonValue,
            providerReference: checkoutRequestId,
            status: "failed"
          }
        });
        return res.json({
          data: { accepted: true, matched: true, activated: false, resultCode, resultDesc: "Payment amount did not match package price" }
        });
      }

      const callbackPhone = phone === undefined || phone === null ? null : formatDarajaMsisdn(String(phone));
      if (callbackPhone && callbackPhone !== intent.customerPhone) {
        console.warn("M-PESA STK callback rejected: phone mismatch for checkoutRequestId=" + checkoutRequestId);
        return res.status(400).json({ error: "Invalid M-PESA callback" });
      }

      let verification: Awaited<ReturnType<typeof queryWifiStkPush>>;
      try {
        verification = await queryWifiStkPush(checkoutRequestId);
      } catch (error) {
        console.error("M-PESA STK callback verification failed for checkoutRequestId=" + checkoutRequestId, error);
        return res.status(503).json({ error: "Unable to verify M-PESA payment yet." });
      }

      if (!isSuccessfulStkQuery(verification, checkoutRequestId)) {
        console.warn("M-PESA STK callback refused: provider query did not confirm success for checkoutRequestId=" + checkoutRequestId);
        return res.status(503).json({ error: "M-PESA payment is not verified yet." });
      }
    }

    const confirmedAt = resultCode === 0 ? new Date() : null;
    await prisma.wifiPaymentIntent.update({
      where: { id: intent.id },
      data: {
        rawPayload: req.body as Prisma.InputJsonValue,
        providerReference: checkoutRequestId,
        receiptNumber: resultCode === 0 && typeof receipt === "string" ? receipt : intent.receiptNumber,
        status: resultCode === 0 ? "confirmed" : "failed",
        confirmedAt
      }
    });

    if (resultCode !== 0) {
      return res.json({ data: { accepted: true, matched: true, activated: false, resultCode, resultDesc: callback.ResultDesc } });
    }

    const activated = await activatePaymentIntent(intent, confirmedAt ?? new Date());
    return res.json({
      data: toJsonSafe({
        accepted: true,
        matched: true,
        activated: true,
        receipt,
        amount,
        phone,
        paymentIntentId: intent.id,
        entitlementId: activated.entitlement.id
      })
    });
  } catch (error) {
    return next(error);
  }
});
