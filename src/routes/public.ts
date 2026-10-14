import crypto from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import type { WifiCredit, WifiPaymentIntent, WifiPlan } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { formatDarajaMsisdn, getMpesaStatus, initiateWifiStkPush, isSuccessfulStkQuery, queryWifiStkPush } from "../services/mpesa.js";
import { buildRadiusProjection, createRadiusSecret, normalizeDeviceMac, normalizeWifiUsername } from "../services/radiusProjection.js";
import { applyRadiusProjectionRows } from "../services/radiusSqlApply.js";
import { claimPromoGrant, getLivePromo } from "../services/promo.js";
import { formatCreditDuration } from "../services/credits.js";
import { bodyFieldKey, clientRateLimit, ipKey } from "../middleware/rateLimitGuard.js";
import { ensureConnectCode, normalizeConnectCode } from "../services/connectCode.js";
import { kickHotspotDevice } from "../services/routeros.js";
import { deviceCap, payingDeviceNeedsSlot, publicDevice } from "../services/deviceLedger.js";
import { MAX_DEVICES, addDeviceQuote, deviceOptions, devicePrice, maxDevicesFor } from "../services/devicePricing.js";
import { LOYALTY_REASON, PURCHASABLE_PLAN_WHERE, climbGap, monthStandings, nairobiMonthStart, tierForRank } from "../services/loyalty.js";
import { boostRateLimit, fasterRateLimit } from "../services/rateLimit.js";

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

// by-device returns cleartext credentials (the hidden-iframe auto-login
// needs them client-side), so unlike most reads here this one is a genuine
// credential-disclosure surface if left unlimited -- a MAC is visible to
// anyone sharing the WiFi (broadcast in every 802.11 frame), so an
// unthrottled lookup would let another device on the same network query a
// victim's known MAC and get their password back. Rate limiting doesn't
// fully close that -- a single targeted guess still gets through -- but it
// kills mass enumeration, which is the realistic version of this attack.
const publicDeviceLookupLimit = clientRateLimit({
  name: "wifi-public-device-lookup",
  windowMs: 15 * 60 * 1000,
  max: 30,
  key: ipKey,
  message: "Too many reconnect attempts. Try again shortly."
});

const publicDeviceListLimit = clientRateLimit({
  name: "wifi-public-device-list",
  windowMs: 15 * 60 * 1000,
  max: 30,
  key: ipKey,
  message: "Too many requests. Try again shortly."
});

const publicDeviceRemoveLimit = clientRateLimit({
  name: "wifi-public-device-remove",
  windowMs: 15 * 60 * 1000,
  max: 20,
  key: ipKey,
  message: "Too many requests. Try again shortly."
});

// Tight on purpose: a 6-character code is only safe against guessing while
// each IP gets a handful of tries.
const publicConnectCodeLimit = clientRateLimit({
  name: "wifi-public-connect-code",
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: ipKey,
  message: "Too many code attempts. Try again shortly."
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

const publicPromoClaimLimit = clientRateLimit({
  name: "wifi-public-promo-claim",
  windowMs: 15 * 60 * 1000,
  max: 20,
  key: ipKey,
  message: "Too many promo attempts. Try again shortly."
});

const publicCreditActivationLimit = clientRateLimit({
  name: "wifi-public-credit-activation",
  windowMs: 15 * 60 * 1000,
  max: 20,
  key: ipKey,
  message: "Too many credit activation attempts. Try again shortly."
});

// "captyn_housing"-sourced plans exist only to record housing-forwarded
// resident payments, and stay out of this list. "captyn_dynamic" plans are
// the traffic-priced rotating offer from DynamicPlanEngine -- purchasable
// like any admin-curated plan, just machine-managed.
const PUBLICLY_PURCHASABLE_SOURCES = ["captyn_admin", "captyn_dynamic"];

const stkRequestSchema = z.object({
  planId: z.string().min(1),
  phone: z.string().min(7),
  deviceMac: z.string().trim().optional().nullable(),
  deviceCount: z.coerce.number().int().min(1).max(MAX_DEVICES).optional(),
  // Confirms adding this device to the number's running package after the
  // 409 "package_on_other_device" answer below.
  addToPackage: z.boolean().optional()
});

const addDeviceStkSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  phone: z.string().min(7),
  deviceCount: z.coerce.number().int().min(2).max(MAX_DEVICES)
});

const freeAccessSchema = z.object({
  planId: z.string().min(1),
  deviceMac: z.string().trim().optional().nullable()
});

const creditActivationSchema = z.object({
  username: z.string().trim().optional().nullable(),
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

class PublicRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) { super(message); }
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
  2001: "Wrong M-PESA PIN. Tap Pay Now to try again.",
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
  startsAt: Date;
  expiresAt: Date;
  deviceLimit: number;
  rateLimit: string | null;
  outagePausedAt: Date | null;
}) {
  const [totalCreditedSeconds, devices] = await Promise.all([
    sumOutageCreditSeconds(entitlement.id),
    prisma.wifiEntitlementDevice.findMany({ where: { entitlementId: entitlement.id }, orderBy: { addedAt: "asc" } })
  ]);
  return {
    username: entitlement.username,
    password: entitlement.cleartextSecret,
    // startsAt lets the portal draw time left as a share of the package.
    startsAt: entitlement.startsAt,
    expiresAt: entitlement.expiresAt,
    deviceLimit: entitlement.deviceLimit,
    deviceCap: deviceCap(entitlement),
    rateLimit: entitlement.rateLimit,
    pausedSince: entitlement.outagePausedAt,
    totalCreditedSeconds,
    deviceCount: devices.length,
    devices: devices.map(publicDevice)
  };
}

// Re-validates ownership of a shared username/password pair the same way
// link-device/remove-device already did inline before this was factored
// out -- these device-management endpoints all need the identical check.
async function authenticateEntitlementOwner(username: string, password: string) {
  const entitlement = await prisma.wifiEntitlement.findFirst({
    where: { username, ...activeAccessWhere(new Date()) },
    orderBy: { createdAt: "desc" }
  });
  if (!entitlement || entitlement.cleartextSecret !== password) return null;
  return entitlement;
}

// An entitlement paused for outage credit (see outageCredit.ts) or paused
// for a promo (see promo.ts) keeps its pre-pause expiresAt until it's
// resumed -- crediting/restoring only happens then, not before -- so a
// customer paused longer than their remaining balance would otherwise look
// expired here well before the backend has actually given up on them.
// Either pause flag being set means the clock is frozen, regardless of how
// stale expiresAt has become.
function activeAccessWhere(now: Date): Prisma.WifiEntitlementWhereInput {
  return {
    status: "active",
    OR: [{ expiresAt: { gt: now } }, { outagePausedAt: { not: null } }, { promoPausedAt: { not: null } }]
  };
}

function activeCreditWhere(now: Date): Prisma.WifiCreditWhereInput {
  return { consumedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

function creditActivationBody(credit: WifiCredit): string {
  const expiryHint = credit.expiresAt ? ` Activate within ${formatCreditDuration(Math.max(0, Math.round((credit.expiresAt.getTime() - Date.now()) / 1000)))}.` : "";
  if (credit.reason === "LOYALTY_REWARD") return `Thanks for being a regular: ${formatCreditDuration(credit.durationSeconds)} free. Tap Activate when you want it to start.${expiryHint}`;
  return `${formatCreditDuration(credit.durationSeconds)} of free WiFi is ready. Tap Activate when you want it to start.${expiryHint}`;
}

function publicCreditNotification(credit: WifiCredit, now = new Date()) {
  const available = !credit.consumedAt && (!credit.expiresAt || credit.expiresAt > now);
  return {
    id: `credit-${credit.id}`,
    type: "credit_available",
    title: credit.reason === "LOYALTY_REWARD" ? "Free WiFi, on us" : "Free internet waiting",
    body: creditActivationBody(credit),
    readAt: null,
    createdAt: credit.createdAt,
    data: { creditId: credit.id, durationSeconds: credit.durationSeconds, reason: credit.reason, expiresAt: credit.expiresAt, deviceMac: credit.deviceMac, consumedAt: credit.consumedAt, activatable: available }
  };
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

// Raises the target package's device limit and re-applies its RADIUS rows
// (Simultaneous-Use) so the extra device can sign in straight away.
async function applyAddDevicePayment(tx: Prisma.TransactionClient, paymentIntent: WifiPaymentIntent & { site: unknown; plan: WifiPlan }, now: Date) {
  const target = await tx.wifiEntitlement.findUnique({
    where: { id: paymentIntent.targetEntitlementId as string },
    include: { projection: true }
  });
  if (!target) throw new Error("Package for this device upgrade not found");

  const deviceLimit = Math.max(target.deviceLimit, paymentIntent.deviceCount ?? target.deviceLimit);
  const entitlement = await tx.wifiEntitlement.update({ where: { id: target.id }, data: { deviceLimit } });
  const projection = buildRadiusProjection({
    entitlementId: entitlement.id,
    phone: entitlement.customerPhone,
    username: entitlement.username,
    password: entitlement.cleartextSecret,
    deviceMac: entitlement.deviceMac,
    expiresAt: entitlement.expiresAt,
    durationSeconds: Math.max(60, Math.round((entitlement.expiresAt.getTime() - now.getTime()) / 1000)),
    rateLimit: entitlement.rateLimit,
    deviceLimit
  });
  await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
  const radiusProjection = target.projection
    ? await tx.wifiRadiusProjection.update({
        where: { id: target.projection.id },
        data: { checkItems: projection.checkItems, replyItems: projection.replyItems, status: "applied", appliedAt: now, lastError: null }
      })
    : await tx.wifiRadiusProjection.create({
        data: { entitlementId: entitlement.id, username: projection.username, checkItems: projection.checkItems, replyItems: projection.replyItems, status: "applied", appliedAt: now }
      });
  const updatedIntent = await tx.wifiPaymentIntent.update({
    where: { id: paymentIntent.id },
    data: { status: "activated", confirmedAt: now },
    include: { site: true, plan: true }
  });
  return { intent: updatedIntent, entitlement, projection: radiusProjection, alreadyProcessed: false, extended: true };
}

// Marks the reward card a payment redeems as used and returns its bonus.
// Only the first payment to land claims it, so a retried prompt can't
// double the bonus.
async function claimRewardBoost(tx: Prisma.TransactionClient, paymentIntent: WifiPaymentIntent, at: Date) {
  const none = { bonusSeconds: 0, speedBoostPct: 0 };
  if (!paymentIntent.loyaltyRewardId) return none;
  const claimed = await tx.wifiLoyaltyReward.updateMany({
    where: { id: paymentIntent.loyaltyRewardId, status: "available" },
    data: { status: "claimed", choice: paymentIntent.planId, claimedAt: at, paymentIntentId: paymentIntent.id }
  });
  if (!claimed.count) return none;
  const reward = await tx.wifiLoyaltyReward.findUnique({ where: { id: paymentIntent.loyaltyRewardId } });
  return reward ? { bonusSeconds: reward.bonusSeconds, speedBoostPct: reward.speedBoostPct } : none;
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

    if (paymentIntent.purpose === "add_device" && paymentIntent.targetEntitlementId) {
      return applyAddDevicePayment(tx, paymentIntent, startsAt);
    }

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

    // A weekly reward card paid for here adds its bonus time and speed.
    const boost = await claimRewardBoost(tx, paymentIntent, startsAt);

    if (existingActive) {
      // Extending only ever adds time — it must never touch the plan/rate
      // limit/device limit the customer already has. A cheap top-up (e.g. a
      // 30-minute Flash pass) bought while a longer, better-tier entitlement
      // (e.g. a Weekly pass) is still active must not downgrade that
      // customer's speed or device limit to the top-up's tier.
      // Paused entitlements can have a stale expiresAt while their clock is
      // frozen. A paid top-up must start from now in that case, otherwise the
      // customer only gets "old expiry + package duration" instead of the
      // full package they just paid for.
      const extensionBase = existingActive.expiresAt > startsAt ? existingActive.expiresAt : startsAt;
      const extendedExpiresAt = new Date(extensionBase.getTime() + (paymentIntent.plan.durationSeconds + boost.bonusSeconds) * 1000);
      // A reward's boosted speed only ever raises the package's speed.
      const boostedRate = boost.speedBoostPct ? fasterRateLimit(existingActive.rateLimit, boostRateLimit(paymentIntent.plan.rateLimit, boost.speedBoostPct)) : existingActive.rateLimit;
      const extendedEntitlement = await tx.wifiEntitlement.update({
        where: { id: existingActive.id },
        // A fresh payment reactivates RADIUS right now (below), so an
        // outage pause on this entitlement is moot -- clear it here rather
        // than leaving it for the outage sweep to later re-credit and
        // re-apply a projection this payment has already superseded.
        data: { expiresAt: extendedExpiresAt, rateLimit: boostedRate, outagePausedAt: null, outagePauseCause: null }
      });
      const extendedProjection = buildRadiusProjection({
        entitlementId: extendedEntitlement.id,
        phone: paymentIntent.customerPhone,
        username: extendedEntitlement.username,
        password: extendedEntitlement.cleartextSecret,
        deviceMac: extendedEntitlement.deviceMac,
        expiresAt: extendedExpiresAt,
        durationSeconds: Math.max(60, Math.round((extendedExpiresAt.getTime() - startsAt.getTime()) / 1000)),
        rateLimit: extendedEntitlement.rateLimit,
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

    const durationSeconds = paymentIntent.plan.durationSeconds + boost.bonusSeconds;
    const rateLimit = boost.speedBoostPct ? boostRateLimit(paymentIntent.plan.rateLimit, boost.speedBoostPct) : paymentIntent.plan.rateLimit;
    const expiresAt = new Date(startsAt.getTime() + durationSeconds * 1000);
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
        deviceLimit: paymentIntent.deviceCount ?? paymentIntent.plan.deviceLimit,
        rateLimit,
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
      durationSeconds,
      rateLimit,
      deviceLimit: entitlement.deviceLimit
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

async function resolveCreditPlan(tx: Prisma.TransactionClient, credit: WifiCredit) {
  if (credit.planId) {
    const plan = await tx.wifiPlan.findUnique({ where: { id: credit.planId } });
    if (plan) return plan;
  }

  const latestEntitlement = await tx.wifiEntitlement.findFirst({
    where: { customerPhone: credit.customerPhone },
    include: { plan: true },
    orderBy: { createdAt: "desc" }
  });
  if (latestEntitlement?.plan) return latestEntitlement.plan;

  const latestIntent = await tx.wifiPaymentIntent.findFirst({
    where: { customerPhone: credit.customerPhone },
    include: { plan: true },
    orderBy: { createdAt: "desc" }
  });
  if (latestIntent?.plan) return latestIntent.plan;

  const fallback = await tx.wifiPlan.findFirst({
    where: { ...(credit.siteId ? { siteId: credit.siteId } : {}), enabled: true },
    orderBy: [{ featured: "desc" }, { priceKsh: "asc" }, { durationSeconds: "asc" }, { name: "asc" }]
  });
  if (fallback) return fallback;
  throw new PublicRouteError(500, "No WiFi package template is available for this credit.");
}

async function activateWifiCredit(creditId: string, input: z.infer<typeof creditActivationSchema>) {
  const requestedUsername = input.username ? normalizeWifiUsername(input.username) : null;
  const requestedDeviceMac = normalizeDeviceMac(input.deviceMac);
  const startsAt = new Date();

  return prisma.$transaction(async (tx) => {
    const credit = await tx.wifiCredit.findUnique({ where: { id: creditId } });
    if (!credit) throw new PublicRouteError(404, "Credit not found.");
    if (credit.consumedAt) throw new PublicRouteError(409, "This credit has already been used.");
    if (credit.expiresAt && credit.expiresAt <= startsAt) throw new PublicRouteError(410, "This credit has expired.");

    const accountMatches = requestedUsername !== null && requestedUsername === credit.customerPhone;
    const deviceMatches = requestedDeviceMac !== null && credit.deviceMac !== null && requestedDeviceMac === credit.deviceMac;
    if (credit.deviceMac) {
      if (!deviceMatches) throw new PublicRouteError(403, "This credit was issued for another device. Reopen CAPTYN WiFi from the credited device.");
    } else if (!accountMatches) {
      throw new PublicRouteError(403, "This credit belongs to another account.");
    }

    const claimed = await tx.wifiCredit.updateMany({
      where: { id: credit.id, ...activeCreditWhere(startsAt) },
      data: { consumedAt: startsAt }
    });
    if (claimed.count !== 1) throw new PublicRouteError(409, "This credit is no longer available.");

    const plan = await resolveCreditPlan(tx, credit);
    const planId = credit.planId ?? plan.id;
    const siteId = credit.siteId ?? plan.siteId;
    const username = normalizeWifiUsername(credit.customerPhone);
    const activationDeviceMac = credit.deviceMac ?? requestedDeviceMac;
    const rateLimit = credit.rateLimit ?? plan.rateLimit;
    const deviceLimit = credit.deviceLimit ?? plan.deviceLimit;
    const rawPayloadBase = {
      creditId: credit.id,
      creditSourceReference: credit.sourceReference,
      reason: credit.reason,
      durationSeconds: credit.durationSeconds,
      activatedAt: startsAt.toISOString()
    };

    const intent = await tx.wifiPaymentIntent.create({
      data: {
        siteId,
        planId,
        source: "captyn_wifi_credit",
        sourceReference: `credit-${credit.id}`,
        customerPhone: credit.customerPhone,
        deviceMac: activationDeviceMac,
        amountKsh: 0,
        provider: "credit",
        providerReference: credit.id,
        status: "activated",
        confirmedAt: startsAt,
        rawPayload: rawPayloadBase as Prisma.InputJsonValue
      }
    });

    const existingActive = await tx.wifiEntitlement.findFirst({
      where: { username, ...activeAccessWhere(startsAt) },
      include: { projection: true },
      orderBy: { expiresAt: "desc" }
    });

    if (existingActive) {
      const extensionBase = existingActive.expiresAt > startsAt ? existingActive.expiresAt : startsAt;
      const extendedExpiresAt = new Date(extensionBase.getTime() + credit.durationSeconds * 1000);
      const extendedEntitlement = await tx.wifiEntitlement.update({
        where: { id: existingActive.id },
        data: {
          expiresAt: extendedExpiresAt,
          outagePausedAt: null,
          outagePauseCause: null,
          ...(activationDeviceMac ? { deviceMac: activationDeviceMac } : {})
        }
      });
      const extendedProjection = buildRadiusProjection({
        entitlementId: extendedEntitlement.id,
        phone: credit.customerPhone,
        username: extendedEntitlement.username,
        password: extendedEntitlement.cleartextSecret,
        deviceMac: activationDeviceMac ?? extendedEntitlement.deviceMac,
        expiresAt: extendedExpiresAt,
        durationSeconds: Math.max(60, Math.round((extendedExpiresAt.getTime() - startsAt.getTime()) / 1000)),
        rateLimit: existingActive.rateLimit,
        deviceLimit: existingActive.deviceLimit
      });

      await applyRadiusProjectionRows(tx, extendedProjection.username, extendedProjection.checkItems, extendedProjection.replyItems);
      const radiusProjection = existingActive.projection
        ? await tx.wifiRadiusProjection.update({
            where: { id: existingActive.projection.id },
            data: { checkItems: extendedProjection.checkItems, replyItems: extendedProjection.replyItems, status: "applied", appliedAt: startsAt, lastError: null }
          })
        : await tx.wifiRadiusProjection.create({
            data: { entitlementId: extendedEntitlement.id, username: extendedProjection.username, checkItems: extendedProjection.checkItems, replyItems: extendedProjection.replyItems, status: "applied", appliedAt: startsAt }
          });

      await tx.wifiCredit.update({ where: { id: credit.id }, data: { consumedEntitlementId: extendedEntitlement.id } });
      await tx.wifiPaymentIntent.update({ where: { id: intent.id }, data: { rawPayload: { ...rawPayloadBase, entitlementId: extendedEntitlement.id, extended: true } as Prisma.InputJsonValue } });
      await tx.wifiNotification.updateMany({ where: { customerPhone: credit.customerPhone, type: "credit_granted", data: { path: ["creditId"], equals: credit.id } }, data: { readAt: startsAt } });
      return { intent, entitlement: extendedEntitlement, projection: radiusProjection, extended: true };
    }

    const expiresAt = new Date(startsAt.getTime() + credit.durationSeconds * 1000);
    const password = createRadiusSecret();
    const entitlement = await tx.wifiEntitlement.create({
      data: {
        siteId,
        planId,
        paymentIntentId: intent.id,
        customerPhone: credit.customerPhone,
        username,
        cleartextSecret: password,
        deviceMac: activationDeviceMac,
        status: "active",
        startsAt,
        expiresAt,
        deviceLimit,
        rateLimit,
        acctInterimSeconds: config.defaultAcctInterimSeconds
      }
    });

    const projection = buildRadiusProjection({ entitlementId: entitlement.id, phone: credit.customerPhone, username, password, deviceMac: activationDeviceMac, expiresAt, durationSeconds: credit.durationSeconds, rateLimit, deviceLimit });
    await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
    const radiusProjection = await tx.wifiRadiusProjection.create({ data: { entitlementId: entitlement.id, username: projection.username, checkItems: projection.checkItems, replyItems: projection.replyItems, status: "applied", appliedAt: startsAt } });
    await tx.wifiCredit.update({ where: { id: credit.id }, data: { consumedEntitlementId: entitlement.id } });
    await tx.wifiPaymentIntent.update({ where: { id: intent.id }, data: { rawPayload: { ...rawPayloadBase, entitlementId: entitlement.id, extended: false } as Prisma.InputJsonValue } });
    await tx.wifiNotification.updateMany({ where: { customerPhone: credit.customerPhone, type: "credit_granted", data: { path: ["creditId"], equals: credit.id } }, data: { readAt: startsAt } });
    return { intent, entitlement, projection: radiusProjection, extended: false };
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

// Restored after being disabled in favor of localStorage-only recognition
// (see attemptReturningDeviceAutoConnect in the portal) -- that swap traded
// one reliability gap for a worse one. MAC rotation only ever produces false
// negatives (fails to recognize a device it should), never false positives,
// since it can't accidentally match a *different* real customer. But
// localStorage-only fails every device whose captive-portal helper opens a
// fresh, non-persistent webview each reconnect (common on iOS/Android) --
// including devices with a perfectly stable MAC that this endpoint would
// have caught. Kept as a layered fallback alongside localStorage, not a
// replacement for it, with rate limiting for the credential-disclosure risk
// noted above.
publicRouter.get("/entitlements/by-device/:mac", publicDeviceLookupLimit, async (req, res, next) => {
  try {
    const mac = normalizeDeviceMac(req.params.mac);
    if (!mac) return res.status(400).json({ error: "Device MAC required" });
    const entitlement = await prisma.wifiEntitlement.findFirst({
      where: { deviceMac: mac, ...activeAccessWhere(new Date()) },
      orderBy: { expiresAt: "desc" }
    });
    if (!entitlement) return res.status(404).json({ error: "No active access for this device" });
    return res.json({ data: toJsonSafe(await publicEntitlement(entitlement)) });
  } catch (error) {
    return next(error);
  }
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
//
// Used to just overwrite a single WifiEntitlement.deviceMac scalar -- so a
// 2nd device linking silently evicted the 1st with no record of it ever
// happening. Now upserts into WifiEntitlementDevice (the real registered
// list) and enforces deviceLimit here at the app layer. This is layered on
// top of, not instead of, RADIUS's own Simultaneous-Use check: that keeps
// capping concurrent sessions by username regardless of this table, so a
// device can still get *network* access past its owner's registered-device
// count until a session naturally expires -- this endpoint only controls
// whether the device gets remembered for frictionless auto-reconnect.
publicRouter.post("/entitlements/link-device", publicCredentialLinkLimit, async (req, res, next) => {
  try {
    const parsed = linkDeviceSchema.parse(req.body);
    const mac = normalizeDeviceMac(parsed.deviceMac);
    if (!mac) return res.status(400).json({ error: "Device MAC required" });

    const entitlement = await authenticateEntitlementOwner(parsed.username, parsed.password);
    if (!entitlement) {
      return res.status(404).json({ error: "No matching active access record" });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Locks the entitlement row so concurrent link-device calls for the
      // SAME entitlement serialize instead of racing: without this, two
      // requests arriving together can both read "count is still under the
      // limit" before either has committed its insert, and both proceed --
      // verified this actually happens (6 concurrent requests against a
      // deviceLimit: 2 entitlement produced 4 registered devices). Postgres
      // blocks the second FOR UPDATE until the first transaction commits,
      // so by the time it runs its own count, the first insert is visible.
      await tx.$queryRaw`SELECT id FROM "WifiEntitlement" WHERE id = ${entitlement.id} FOR UPDATE`;

      const existing = await tx.wifiEntitlementDevice.findUnique({
        where: { entitlementId_deviceMac: { entitlementId: entitlement.id, deviceMac: mac } }
      });
      if (existing) {
        await tx.wifiEntitlementDevice.update({ where: { id: existing.id }, data: { lastSeenAt: new Date(), signedOutAt: null } });
        return "already_registered" as const;
      }

      // Same allowance FreeRADIUS enforces at sign-in (captyn_device_over_cap).
      const registeredCount = await tx.wifiEntitlementDevice.count({ where: { entitlementId: entitlement.id } });
      if (registeredCount >= deviceCap(entitlement)) {
        return "at_limit" as const;
      }

      await tx.wifiEntitlementDevice.create({ data: { entitlementId: entitlement.id, deviceMac: mac } });
      return "added" as const;
    });

    if (result === "at_limit") {
      const devices = await prisma.wifiEntitlementDevice.findMany({
        where: { entitlementId: entitlement.id },
        orderBy: { addedAt: "asc" }
      });
      return res.status(409).json({
        error: "DEVICE_LIMIT_REACHED",
        message: `This package has already been used on ${deviceCap(entitlement)} different devices, its limit. Use a device you've signed in with before.`,
        data: {
          deviceLimit: entitlement.deviceLimit,
          deviceCap: deviceCap(entitlement),
          devices: devices.map(publicDevice)
        }
      });
    }

    if (entitlement.deviceMac !== mac) {
      await prisma.wifiEntitlement.update({ where: { id: entitlement.id }, data: { deviceMac: mac } });
    }
    const devices = await prisma.wifiEntitlementDevice.findMany({
      where: { entitlementId: entitlement.id },
      orderBy: { addedAt: "asc" }
    });
    return res.json({
      data: {
        linked: true,
        status: result,
        deviceLimit: entitlement.deviceLimit,
        deviceCap: deviceCap(entitlement),
        devices: devices.map(publicDevice)
      }
    });
  } catch (error) {
    return next(error);
  }
});

const deviceListSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
});

// POST (not GET+query) so the password never lands in a query string or
// access log the way `/entitlements/by-device/:mac` deliberately avoids too.
publicRouter.post("/entitlements/devices/list", publicDeviceListLimit, async (req, res, next) => {
  try {
    const parsed = deviceListSchema.parse(req.body);
    const entitlement = await authenticateEntitlementOwner(parsed.username, parsed.password);
    if (!entitlement) return res.status(404).json({ error: "No matching active access record" });

    const devices = await prisma.wifiEntitlementDevice.findMany({
      where: { entitlementId: entitlement.id },
      orderBy: { addedAt: "asc" }
    });
    const connectCode = await ensureConnectCode(prisma, entitlement);
    return res.json({
      data: {
        deviceLimit: entitlement.deviceLimit,
        connectCode,
        deviceCap: deviceCap(entitlement),
        deviceCount: devices.length,
        devices: devices.map(publicDevice)
      }
    });
  } catch (error) {
    return next(error);
  }
});

const redeemConnectCodeSchema = z.object({ code: z.string().trim().min(1).max(32) });

// A device that isn't remembered signs in with the short code shown on an
// already-connected device. Returns the entitlement's own RADIUS
// credentials, so the new device still counts against Simultaneous-Use.
publicRouter.post("/entitlements/connect-code/redeem", publicConnectCodeLimit, async (req, res, next) => {
  try {
    const parsed = redeemConnectCodeSchema.parse(req.body);
    const code = normalizeConnectCode(parsed.code);
    if (!code) return res.status(404).json({ error: "That code isn't valid. Check it on your connected device." });

    const entitlement = await prisma.wifiEntitlement.findFirst({
      where: { connectCode: code, ...activeAccessWhere(new Date()) }
    });
    if (!entitlement) return res.status(404).json({ error: "That code isn't valid or the access has expired." });

    return res.json({
      data: {
        username: entitlement.username,
        password: entitlement.cleartextSecret,
        expiresAt: entitlement.expiresAt,
        deviceLimit: entitlement.deviceLimit
      }
    });
  } catch (error) {
    return next(error);
  }
});

const signOutDeviceSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  deviceMac: z.string().trim().min(1)
});

// "Sign out this device": ends this device's router session (freeing a slot
// for another device on a multi-device package) and forgets it, so the
// portal's returning-device lookup doesn't sign it straight back in. The
// package's clock keeps running -- access is bought by time, not usage.
publicRouter.post("/entitlements/sign-out-device", publicDeviceRemoveLimit, async (req, res, next) => {
  try {
    const parsed = signOutDeviceSchema.parse(req.body);
    const mac = normalizeDeviceMac(parsed.deviceMac);
    if (!mac) return res.status(400).json({ error: "Device MAC required" });

    const entitlement = await authenticateEntitlementOwner(parsed.username, parsed.password);
    if (!entitlement) return res.status(404).json({ error: "No matching active access record" });

    // Marked, not deleted: the device still counts toward the switch cap,
    // so signing out can't be used to rotate an unlimited number of devices.
    await prisma.wifiEntitlementDevice.updateMany({ where: { entitlementId: entitlement.id, deviceMac: mac }, data: { signedOutAt: new Date() } });
    if (entitlement.deviceMac === mac) {
      await prisma.wifiEntitlement.update({ where: { id: entitlement.id }, data: { deviceMac: null } });
    }

    const kick = await kickHotspotDevice(mac);
    if (kick.error || kick.skippedReason) {
      console.warn(`Sign-out kick ${mac} did not complete: ${kick.error || kick.skippedReason}`);
    }
    return res.json({ data: { signedOut: kick.removed > 0, disconnected: kick.removed } });
  } catch (error) {
    return next(error);
  }
});

const removeDeviceSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  deviceMac: z.string().trim().min(1)
});

// Customer self-service removal, freeing a slot without waiting for a stale
// RADIUS session to naturally time out.
publicRouter.post("/entitlements/remove-device", publicDeviceRemoveLimit, async (req, res, next) => {
  try {
    const parsed = removeDeviceSchema.parse(req.body);
    const mac = normalizeDeviceMac(parsed.deviceMac);
    if (!mac) return res.status(400).json({ error: "Device MAC required" });

    const entitlement = await authenticateEntitlementOwner(parsed.username, parsed.password);
    if (!entitlement) return res.status(404).json({ error: "No matching active access record" });

    // Signs that device out (and disconnects it) rather than deleting it --
    // it still counts toward the package's switch cap.
    const updated = await prisma.wifiEntitlementDevice.updateMany({
      where: { entitlementId: entitlement.id, deviceMac: mac },
      data: { signedOutAt: new Date() }
    });
    if (updated.count === 0) {
      return res.status(404).json({ error: "That device isn't registered on this account." });
    }
    await kickHotspotDevice(mac);

    if (entitlement.deviceMac === mac) {
      // Clear the last-active-device cache so a removed device doesn't keep
      // silently auto-reconnecting via /entitlements/by-device.
      await prisma.wifiEntitlement.update({ where: { id: entitlement.id }, data: { deviceMac: null } });
    }

    const deviceCount = await prisma.wifiEntitlementDevice.count({ where: { entitlementId: entitlement.id } });
    return res.json({ data: { removed: true, deviceCount } });
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
    if (
      entitlement.status !== "active" ||
      (entitlement.expiresAt <= new Date() && !entitlement.outagePausedAt && !entitlement.promoPausedAt)
    ) {
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
    const deviceCount = await prisma.wifiEntitlementDevice.count({ where: { entitlementId: entitlement.id } });
    return res.json({
      data: toJsonSafe({
        status: entitlement.status,
        startsAt: entitlement.startsAt,
        expiresAt: entitlement.expiresAt,
        deviceLimit: entitlement.deviceLimit,
        deviceCount
      })
    });
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

    // A phone with access still running gets a top-up (activation extends
    // it), so charge for the devices that package actually covers -- a
    // 1-device top-up used to extend a 2-device package at the 1-device
    // price. Otherwise the customer's choice, within what this package allows.
    const existingActive = await prisma.wifiEntitlement.findFirst({
      where: { username: normalizeWifiUsername(phone), ...activeAccessWhere(new Date()) },
      orderBy: { expiresAt: "desc" },
      include: { devices: { select: { deviceMac: true, signedOutAt: true } } }
    });

    // A new device paying into a package whose slots are all taken would
    // only buy time for the other device (a laptop paid, stayed offline and
    // the phone got the hours). Offer to add this device instead; the STK
    // PIN on the package's phone is what authorizes it.
    const payingMac = normalizeDeviceMac(parsed.deviceMac);
    if (existingActive && payingMac && payingDeviceNeedsSlot(existingActive, existingActive.devices, payingMac)) {
      const packagePlan = await prisma.wifiPlan.findUnique({ where: { id: existingActive.planId }, include: { site: true } });
      const nextCount = existingActive.deviceLimit + 1;
      const canAdd = Boolean(packagePlan && packagePlan.priceKsh > 0 && nextCount <= maxDevicesFor(packagePlan));
      const addPriceKsh = canAdd && packagePlan ? addDeviceQuote(packagePlan, existingActive, nextCount) : null;

      if (!parsed.addToPackage || !canAdd || !packagePlan || addPriceKsh === null) {
        return res.status(409).json({
          error: canAdd
            ? "This number already has a package running on another device."
            : "This number's package is already in use on another device and can't take more. Pay with a different number for a separate package.",
          code: "package_on_other_device",
          package: {
            expiresAt: existingActive.expiresAt,
            addDevice: canAdd ? { devices: nextCount, priceKsh: addPriceKsh } : null
          }
        });
      }

      const reference = sourceReference();
      const intent = await prisma.wifiPaymentIntent.create({
        data: {
          siteId: existingActive.siteId,
          planId: packagePlan.id,
          source: "captyn_wifi_portal",
          sourceReference: reference,
          customerPhone: phone,
          deviceMac: payingMac,
          amountKsh: addPriceKsh,
          deviceCount: nextCount,
          purpose: "add_device",
          targetEntitlementId: existingActive.id,
          provider: "mpesa",
          status: "pending_confirmation"
        }
      });
      const stk = await initiateWifiStkPush({
        amount: addPriceKsh,
        phoneNumber: phone,
        accountReference: reference.slice(0, 12),
        transactionDesc: `CAPTYN WiFi ${nextCount} devices`.slice(0, 64),
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
        }
      });
      return res.status(201).json({
        data: toJsonSafe({
          id: updated.id,
          status: updated.status,
          sourceReference: updated.sourceReference,
          checkoutRequestId,
          customerMessage: stk.CustomerMessage || stk.ResponseDescription || "Check your phone to complete payment.",
          amountKsh: updated.amountKsh,
          deviceCount: nextCount,
          site: packagePlan.site,
          plan: packagePlan
        })
      });
    }

    const deviceCount = existingActive
      ? existingActive.deviceLimit
      : Math.min(maxDevicesFor(plan), Math.max(plan.deviceLimit, parsed.deviceCount ?? plan.deviceLimit));
    const amountKsh = devicePrice(plan, deviceCount);

    const reference = sourceReference();
    const intent = await prisma.wifiPaymentIntent.create({
      data: {
        siteId: plan.siteId,
        planId: plan.id,
        source: "captyn_wifi_portal",
        sourceReference: reference,
        customerPhone: phone,
        deviceMac: normalizeDeviceMac(parsed.deviceMac),
        amountKsh,
        deviceCount,
        provider: "mpesa",
        status: "pending_confirmation"
      },
      include: { site: true, plan: true }
    });

    const stk = await initiateWifiStkPush({
      amount: amountKsh,
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
        deviceCount: updated.deviceCount,
        site: updated.site,
        plan: updated.plan
      })
    });
  } catch (error) {
    return next(error);
  }
});

const addDeviceQuoteSchema = z.object({ username: z.string().trim().min(1), password: z.string().min(1) });

// What adding devices to the running package costs right now.
publicRouter.post("/entitlements/add-device/quote", publicDeviceListLimit, async (req, res, next) => {
  try {
    const parsed = addDeviceQuoteSchema.parse(req.body);
    const entitlement = await authenticateEntitlementOwner(parsed.username, parsed.password);
    if (!entitlement) return res.status(404).json({ error: "No matching active access record" });
    const plan = await prisma.wifiPlan.findUnique({ where: { id: entitlement.planId } });
    if (!plan || plan.priceKsh <= 0) return res.json({ data: { deviceLimit: entitlement.deviceLimit, options: [] } });
    const options = deviceOptions(plan)
      .filter((option) => option.devices > entitlement.deviceLimit)
      .map((option) => ({ devices: option.devices, priceKsh: addDeviceQuote(plan, entitlement, option.devices) }));
    return res.json({ data: { deviceLimit: entitlement.deviceLimit, options } });
  } catch (error) {
    return next(error);
  }
});

// Pays to raise a running package's device limit; activatePaymentIntent
// applies it to the package (purpose "add_device") instead of selling time.
publicRouter.post("/payments/mpesa/add-device", publicPaymentIpLimit, async (req, res, next) => {
  try {
    const parsed = addDeviceStkSchema.parse(req.body);
    const phone = formatDarajaMsisdn(parsed.phone);
    if (!phone) return res.status(400).json({ error: "Enter a valid Safaricom phone number." });
    const entitlement = await authenticateEntitlementOwner(parsed.username, parsed.password);
    if (!entitlement) return res.status(404).json({ error: "No matching active access record" });
    const plan = await prisma.wifiPlan.findUnique({ where: { id: entitlement.planId } });
    if (!plan || plan.priceKsh <= 0) return res.status(400).json({ error: "This package can't take extra devices." });
    if (parsed.deviceCount <= entitlement.deviceLimit || parsed.deviceCount > maxDevicesFor(plan)) {
      return res.status(400).json({ error: "Pick a number of devices this package offers." });
    }

    const mpesa = getMpesaStatus();
    if (!mpesa.configured) return res.status(503).json({ error: "M-PESA is not configured for WiFi payments." });

    const amountKsh = addDeviceQuote(plan, entitlement, parsed.deviceCount);
    const reference = sourceReference();
    const intent = await prisma.wifiPaymentIntent.create({
      data: {
        siteId: entitlement.siteId,
        planId: plan.id,
        source: "captyn_wifi_portal",
        sourceReference: reference,
        customerPhone: phone,
        amountKsh,
        deviceCount: parsed.deviceCount,
        purpose: "add_device",
        targetEntitlementId: entitlement.id,
        provider: "mpesa",
        status: "pending_confirmation"
      }
    });

    const stk = await initiateWifiStkPush({
      amount: amountKsh,
      phoneNumber: phone,
      accountReference: reference.slice(0, 12),
      transactionDesc: `CAPTYN WiFi ${parsed.deviceCount} devices`.slice(0, 64),
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
      }
    });
    return res.status(201).json({
      data: toJsonSafe({ id: updated.id, status: updated.status, amountKsh, deviceCount: parsed.deviceCount })
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

    // Already settled (a repeated callback, or the reconciler below got there
    // first): activating again would extend a top-up's access twice.
    if (intent.status === "activated" || intent.status === "confirmed") {
      return res.json({ data: { accepted: true, matched: true, activated: intent.status === "activated", duplicate: true } });
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

// Polled by the portal on every load, before it decides whether to show the
// normal package list or a promo landing page -- see claimPromoGrant for why
// this takes priority over the returning-device/remembered-access checks
// while a promo is active.
publicRouter.get("/promo", async (_req, res, next) => {
  try {
    const promo = await getLivePromo(prisma);
    if (!promo) return res.json({ data: { active: false } });
    return res.json({
      data: toJsonSafe({
        active: true,
        heading: promo.heading,
        message: promo.message,
        startsAt: promo.startsAt,
        endsAt: promo.endsAt
      })
    });
  } catch (error) {
    return next(error);
  }
});

const promoClaimSchema = z.object({ deviceMac: z.string().trim().min(1) });

publicRouter.post("/promo/claim", publicPromoClaimLimit, async (req, res, next) => {
  try {
    const parsed = promoClaimSchema.parse(req.body);
    const promo = await getLivePromo(prisma);
    if (!promo) return res.status(404).json({ error: "This offer has ended." });
    const grant = await claimPromoGrant(prisma, promo, parsed.deviceMac);
    return res.json({ data: toJsonSafe(grant) });
  } catch (error) {
    return next(error);
  }
});

// Errors the portal showed a customer (or threw), so a device that "can't
// buy" leaves evidence in the API log instead of failing silently.
const publicClientErrorLimit = clientRateLimit({ name: "public-client-error", windowMs: 60_000, max: 20, key: ipKey });
const clientErrorSchema = z.object({
  message: z.string().max(400),
  kind: z.string().max(40).optional(),
  deviceMac: z.string().max(40).optional().nullable(),
  page: z.string().max(300).optional()
});
publicRouter.post("/client-errors", publicClientErrorLimit, (req, res) => {
  const parsed = clientErrorSchema.safeParse(req.body ?? {});
  if (parsed.success) {
    const { message, kind, deviceMac, page } = parsed.data;
    console.warn(`Portal ${kind || "error"}: ${message} | mac=${deviceMac || "-"} | page=${page || "-"} | ua=${String(req.headers["user-agent"] || "").slice(0, 160)}`);
  }
  res.status(204).end();
});

// ---------- Weekly rewards (see services/loyalty.ts) ----------

// The phone a portal visit belongs to: the signed-in number, or the number
// that last paid from this device.
async function loyaltyPhone(usernameRaw: unknown, deviceMacRaw: unknown): Promise<string | null> {
  const username = typeof usernameRaw === "string" ? normalizeWifiUsername(usernameRaw.trim()) : "";
  if (/^254\d{9}$/.test(username)) return username;
  const deviceMac = normalizeDeviceMac(typeof deviceMacRaw === "string" ? deviceMacRaw : null);
  if (!deviceMac) return null;
  const last = await prisma.wifiPaymentIntent.findFirst({
    where: { deviceMac, status: "activated", amountKsh: { gt: 0 }, createdAt: { gte: new Date(Date.now() - 60 * 24 * 3600 * 1000) } },
    orderBy: { createdAt: "desc" },
    select: { customerPhone: true }
  });
  return last?.customerPhone ?? null;
}

// What a reward package costs this customer: a running package is topped up
// at its own device count, like any checkout.
async function rewardPlanPrice(plan: WifiPlan, phone: string) {
  const existingActive = await prisma.wifiEntitlement.findFirst({
    where: { username: phone, ...activeAccessWhere(new Date()) },
    orderBy: { expiresAt: "desc" },
    select: { deviceLimit: true }
  });
  const deviceCount = existingActive ? existingActive.deviceLimit : plan.deviceLimit;
  return { deviceCount, priceKsh: devicePrice(plan, deviceCount) };
}

publicRouter.get("/loyalty/me", publicDeviceLookupLimit, async (req, res, next) => {
  try {
    const now = new Date();
    const phone = await loyaltyPhone(req.query.username, req.query.deviceMac);
    const { setting, month, ranked } = await monthStandings(prisma, now);
    if (!setting.enabled || !phone) return res.json({ data: { enabled: setting.enabled, known: Boolean(phone) } });
    const tiers = setting.tierList;
    const index = ranked.findIndex((entry) => entry.phone === phone);

    let standing: Record<string, unknown>;
    if (index < 0) {
      const days = await prisma.$queryRaw<Array<{ days: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT ("createdAt" + interval '3 hours')::date)::int AS days FROM "WifiPaymentIntent"
        WHERE "customerPhone" = ${phone} AND status = 'activated' AND "amountKsh" > 0 AND "createdAt" >= ${nairobiMonthStart(now)}`);
      const paidDays = days[0]?.days ?? 0;
      standing = { ranked: false, paidDays, daysToQualify: Math.max(1, setting.minPaidDays - paidDays) };
    } else {
      const me = ranked[index];
      const rank = index + 1;
      const tier = tierForRank(tiers, rank);
      const tierIndex = tier ? tiers.indexOf(tier) : tiers.length;
      const better = tierIndex > 0 ? tiers[tierIndex - 1] : null;
      const nextRank = climbGap(ranked, index, index - 1);
      const nextTier = better ? climbGap(ranked, index, Math.min(index - 1, better.maxRank - 1)) : null;
      standing = {
        ranked: true,
        rank,
        points: me.score,
        paidDays: me.paidDays,
        spentKsh: me.spentKsh,
        tier: tier?.name ?? null,
        nextRank: nextRank ? { rank: rank - 1, ...nextRank } : null,
        nextTier: better && nextTier ? { name: better.name, ...nextTier } : null
      };
    }

    const reward = await prisma.wifiLoyaltyReward.findFirst({
      where: { customerPhone: phone, status: "available", expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" }
    });
    let rewardView: Record<string, unknown> | null = null;
    if (reward) {
      const plans = await prisma.wifiPlan.findMany({ where: { id: { in: reward.offerPlanIds }, ...PURCHASABLE_PLAN_WHERE } });
      const cards = [];
      for (const planId of reward.offerPlanIds) {
        const plan = plans.find((entry) => entry.id === planId);
        if (!plan) continue;
        const { priceKsh } = await rewardPlanPrice(plan, phone);
        cards.push({
          planId: plan.id,
          name: plan.name,
          priceKsh,
          durationSeconds: plan.durationSeconds,
          bonusSeconds: reward.bonusSeconds,
          rateLimit: plan.rateLimit,
          boostedRateLimit: reward.speedBoostPct ? boostRateLimit(plan.rateLimit, reward.speedBoostPct) : plan.rateLimit
        });
      }
      rewardView = { id: reward.id, tier: reward.tier, rank: reward.rank, expiresAt: reward.expiresAt, freeSeconds: reward.freeSeconds, speedBoostPct: reward.speedBoostPct, cards };
    }

    return res.json({
      data: toJsonSafe({
        enabled: true,
        known: true,
        month,
        rankedCount: ranked.length,
        minPaidDays: setting.minPaidDays,
        tiers: tiers.map((tier) => ({ name: tier.name, maxRank: tier.maxRank })),
        standing,
        reward: rewardView
      })
    });
  } catch (error) {
    return next(error);
  }
});

const rewardIdentitySchema = z.object({
  username: z.string().trim().optional().nullable(),
  deviceMac: z.string().trim().optional().nullable()
});

async function ownedAvailableReward(rewardId: string, body: z.infer<typeof rewardIdentitySchema>) {
  const reward = await prisma.wifiLoyaltyReward.findUnique({ where: { id: rewardId } });
  if (!reward) throw new PublicRouteError(404, "Reward not found.");
  const phone = await loyaltyPhone(body.username, body.deviceMac);
  if (phone !== reward.customerPhone) throw new PublicRouteError(403, "This reward belongs to another number.");
  if (reward.status !== "available") throw new PublicRouteError(409, "This reward has already been used.");
  if (reward.expiresAt && reward.expiresAt <= new Date()) throw new PublicRouteError(410, "This reward has expired.");
  return reward;
}

// The free-time card: the reward becomes a credit and starts on this device now.
publicRouter.post("/loyalty/rewards/:id/free", publicCreditActivationLimit, async (req, res, next) => {
  try {
    const body = rewardIdentitySchema.parse(req.body ?? {});
    const deviceMac = normalizeDeviceMac(body.deviceMac);
    if (!deviceMac) return res.status(400).json({ error: "Connect to CAPTYN WiFi, then reopen this page to use your reward." });
    const reward = await ownedAvailableReward(req.params.id, body);
    const now = new Date();
    const claimed = await prisma.wifiLoyaltyReward.updateMany({
      where: { id: reward.id, status: "available" },
      data: { status: "claimed", choice: "free", claimedAt: now }
    });
    if (!claimed.count) return res.status(409).json({ error: "This reward has already been used." });
    const credit = await prisma.wifiCredit.create({
      data: {
        customerPhone: reward.customerPhone,
        deviceMac,
        durationSeconds: reward.freeSeconds,
        reason: LOYALTY_REASON,
        sourceReference: `loyalty-reward:${reward.id}`,
        expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
        createdBy: "loyalty"
      }
    });
    const activated = await activateWifiCredit(credit.id, { username: reward.customerPhone, deviceMac });
    return res.status(201).json({
      data: toJsonSafe({
        id: activated.intent.id,
        status: activated.intent.status,
        sourceReference: activated.intent.sourceReference,
        entitlement: await publicEntitlement(activated.entitlement),
        extended: activated.extended
      })
    });
  } catch (error) {
    if (error instanceof PublicRouteError) return res.status(error.statusCode).json({ error: error.message });
    return next(error);
  }
});

const rewardPaySchema = rewardIdentitySchema.extend({ planId: z.string().min(1) });

// A package card: an M-PESA prompt to the reward's number for that package;
// activation adds the bonus time and speed (claimRewardBoost).
publicRouter.post("/loyalty/rewards/:id/pay", publicPaymentIpLimit, async (req, res, next) => {
  try {
    const body = rewardPaySchema.parse(req.body ?? {});
    const reward = await ownedAvailableReward(req.params.id, body);
    if (!reward.offerPlanIds.includes(body.planId)) return res.status(400).json({ error: "Pick one of this reward's packages." });
    const plan = await prisma.wifiPlan.findFirst({ where: { id: body.planId, ...PURCHASABLE_PLAN_WHERE }, include: { site: true } });
    if (!plan) return res.status(404).json({ error: "That package isn't on sale right now." });
    const mpesa = getMpesaStatus();
    if (!mpesa.configured) return res.status(503).json({ error: "M-PESA is not configured for WiFi payments." });

    const payingMac = normalizeDeviceMac(body.deviceMac);
    const existingActive = await prisma.wifiEntitlement.findFirst({
      where: { username: reward.customerPhone, ...activeAccessWhere(new Date()) },
      orderBy: { expiresAt: "desc" },
      include: { devices: { select: { deviceMac: true, signedOutAt: true } } }
    });
    if (existingActive && payingMac && payingDeviceNeedsSlot(existingActive, existingActive.devices, payingMac)) {
      return res.status(409).json({ error: "Your package is running on another device. Use this reward from that device." });
    }
    const { deviceCount, priceKsh } = await rewardPlanPrice(plan, reward.customerPhone);

    const reference = sourceReference();
    const intent = await prisma.wifiPaymentIntent.create({
      data: {
        siteId: plan.siteId,
        planId: plan.id,
        source: "captyn_wifi_portal",
        sourceReference: reference,
        customerPhone: reward.customerPhone,
        deviceMac: payingMac,
        amountKsh: priceKsh,
        deviceCount,
        loyaltyRewardId: reward.id,
        provider: "mpesa",
        status: "pending_confirmation"
      }
    });
    const stk = await initiateWifiStkPush({
      amount: priceKsh,
      phoneNumber: reward.customerPhone,
      accountReference: reference.slice(0, 12),
      transactionDesc: `CAPTYN WiFi ${plan.name} reward`.slice(0, 64),
      callbackUrl: config.mpesa.callbackUrl
    });
    const checkoutRequestId = typeof stk.CheckoutRequestID === "string" ? stk.CheckoutRequestID : null;
    const responseCode = typeof stk.ResponseCode === "string" ? stk.ResponseCode : null;
    const updated = await prisma.wifiPaymentIntent.update({
      where: { id: intent.id },
      data: { providerReference: checkoutRequestId, status: responseCode === "0" ? "pending_confirmation" : "failed", rawPayload: stk as Prisma.InputJsonValue }
    });
    return res.status(201).json({
      data: toJsonSafe({
        id: updated.id,
        status: updated.status,
        sourceReference: updated.sourceReference,
        checkoutRequestId,
        customerMessage: stk.CustomerMessage || stk.ResponseDescription || "Check your phone to complete payment.",
        amountKsh: priceKsh,
        deviceCount,
        site: plan.site,
        plan
      })
    });
  } catch (error) {
    if (error instanceof PublicRouteError) return res.status(error.statusCode).json({ error: error.message });
    return next(error);
  }
});

publicRouter.get("/credits/redeemable", async (req, res, next) => {
  try {
    const now = new Date();
    const usernameParam = typeof req.query.username === "string" ? req.query.username.trim() : "";
    const username = usernameParam ? normalizeWifiUsername(usernameParam) : null;
    const deviceMac = normalizeDeviceMac(typeof req.query.deviceMac === "string" ? req.query.deviceMac : null);
    const identityFilters: Prisma.WifiCreditWhereInput[] = [];
    if (deviceMac) identityFilters.push({ deviceMac });
    if (username) identityFilters.push({ customerPhone: username, deviceMac: null });
    if (!identityFilters.length) return res.json({ data: { notifications: [], unreadCount: 0 } });

    const credits = await prisma.wifiCredit.findMany({
      where: { AND: [activeCreditWhere(now), { OR: identityFilters }] },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    const notifications = credits.map((credit) => publicCreditNotification(credit, now));
    return res.json({ data: toJsonSafe({ notifications, unreadCount: notifications.length }) });
  } catch (error) {
    return next(error);
  }
});

publicRouter.post("/credits/:id/activate", publicCreditActivationLimit, async (req, res, next) => {
  try {
    const parsed = creditActivationSchema.parse(req.body);
    const activated = await activateWifiCredit(req.params.id, parsed);
    return res.status(201).json({
      data: toJsonSafe({
        id: activated.intent.id,
        status: activated.intent.status,
        sourceReference: activated.intent.sourceReference,
        amountKsh: activated.intent.amountKsh,
        entitlement: await publicEntitlement(activated.entitlement),
        extended: activated.extended
      })
    });
  } catch (error) {
    if (error instanceof PublicRouteError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return res.status(409).json({ error: "This credit has already been activated." });
    }
    return next(error);
  }
});

// Same trust model as /entitlements/:username/status -- no separate secret,
// just the username, matching this API's existing risk tolerance for
// low-sensitivity reads.
publicRouter.get("/notifications/:username", async (req, res, next) => {
  try {
    const username = req.params.username.trim();
    if (!username) return res.status(400).json({ error: "Username required" });
    const notifications = await prisma.wifiNotification.findMany({
      where: { customerPhone: username },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    const unreadCount = notifications.filter((item) => !item.readAt).length;
    return res.json({ data: toJsonSafe({ notifications, unreadCount }) });
  } catch (error) {
    return next(error);
  }
});

publicRouter.post("/notifications/:id/read", async (req, res, next) => {
  try {
    await prisma.wifiNotification.updateMany({
      where: { id: req.params.id, readAt: null },
      data: { readAt: new Date() }
    });
    return res.json({ data: { ok: true } });
  } catch (error) {
    return next(error);
  }
});

// The callback refuses to activate until an STK query confirms the payment,
// and answers 503 when that query isn't conclusive yet -- but Safaricom
// doesn't resend callbacks, so such a payment sat pending until the worker
// marked it failed, even when the customer had paid. Ask M-PESA directly
// about payments still pending after the prompt should have been answered.
const RECONCILE_AFTER_MS = 90_000;
const RECONCILE_WINDOW_MS = 2 * 60 * 60 * 1000;

export async function reconcilePendingMpesaPayments(): Promise<{ activated: number; failed: number }> {
  const now = Date.now();
  const pending = await prisma.wifiPaymentIntent.findMany({
    where: {
      provider: "mpesa",
      status: "pending_confirmation",
      providerReference: { not: null },
      createdAt: { lt: new Date(now - RECONCILE_AFTER_MS), gt: new Date(now - RECONCILE_WINDOW_MS) }
    },
    orderBy: { createdAt: "asc" },
    take: 20
  });

  let activated = 0;
  let failed = 0;
  for (const intent of pending) {
    const checkoutRequestId = intent.providerReference as string;
    let query: Awaited<ReturnType<typeof queryWifiStkPush>>;
    try {
      query = await queryWifiStkPush(checkoutRequestId);
    } catch {
      continue; // still processing, or Daraja unreachable -- try next round
    }
    if (query?.CheckoutRequestID !== checkoutRequestId || query.ResultCode === undefined || query.ResultCode === null || query.ResultCode === "") continue;

    const resultCode = Number(query.ResultCode);
    const rawPayload = {
      source: "stk-query",
      Body: { stkCallback: { CheckoutRequestID: checkoutRequestId, ResultCode: resultCode, ResultDesc: query.ResultDesc } }
    } as Prisma.InputJsonValue;

    if (isSuccessfulStkQuery(query, checkoutRequestId)) {
      const confirmedAt = new Date();
      const claimed = await prisma.wifiPaymentIntent.updateMany({
        where: { id: intent.id, status: "pending_confirmation" },
        data: { status: "confirmed", confirmedAt, rawPayload }
      });
      if (claimed.count === 0) continue; // the callback settled it meanwhile
      await activatePaymentIntent(intent, confirmedAt);
      activated += 1;
    } else {
      const updated = await prisma.wifiPaymentIntent.updateMany({
        where: { id: intent.id, status: "pending_confirmation" },
        data: { status: "failed", rawPayload }
      });
      failed += updated.count;
    }
  }
  return { activated, failed };
}
