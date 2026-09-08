import type { Prisma, PrismaClient, WifiPromo } from "@prisma/client";
import { buildRadiusProjection, createRadiusSecret, normalizeDeviceMac } from "./radiusProjection.js";
import { applyRadiusProjectionRows, hasOtherActiveEntitlement } from "./radiusSqlApply.js";

const PROMO_PLAN_SOURCE = "captyn_wifi_promo";
const PROMO_PLAN_EXTERNAL_ID = "free-surfing-promo";

export type StartPromoInput = {
  siteId: string;
  heading?: string | null;
  message?: string | null;
  startsAt?: Date;
  endsAt: Date;
  rateLimit?: string | null;
  deviceLimit?: number;
  pauseExisting?: boolean;
};

function promoUsername(deviceMac: string) {
  return `promo-${deviceMac.replace(/[^A-F0-9]/gi, "").toLowerCase()}`;
}

export async function getActivePromo(prisma: PrismaClient): Promise<WifiPromo | null> {
  return prisma.wifiPromo.findFirst({ where: { active: true }, orderBy: { createdAt: "desc" } });
}

export async function getLivePromo(prisma: PrismaClient, now = new Date()): Promise<WifiPromo | null> {
  return prisma.wifiPromo.findFirst({
    where: { active: true, activatedAt: { not: null }, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: "desc" }
  });
}

async function pauseExistingEntitlements(tx: Prisma.TransactionClient, pausedAt: Date) {
  return tx.wifiEntitlement.updateMany({
    where: { status: "active", outagePausedAt: null, promoPausedAt: null, expiresAt: { gt: pausedAt } },
    data: { promoPausedAt: pausedAt }
  });
}

export async function activateDuePromos(prisma: PrismaClient, now = new Date()): Promise<{ activated: number; paused: number }> {
  const promo = await prisma.wifiPromo.findFirst({
    where: { active: true, activatedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: "asc" }
  });
  if (!promo) return { activated: 0, paused: 0 };

  return prisma.$transaction(async (tx) => {
    const updated = await tx.wifiPromo.updateMany({
      where: { id: promo.id, active: true, activatedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
      data: { activatedAt: now }
    });
    if (updated.count === 0) return { activated: 0, paused: 0 };

    const paused = promo.pauseExisting ? await pauseExistingEntitlements(tx, now) : { count: 0 };
    return { activated: 1, paused: paused.count };
  });
}

// Freezes every currently-ticking paid entitlement's clock (mirrors the
// outage-pause technique, but on promoPausedAt -- kept separate from
// outagePausedAt so this deliberate admin action never gets mixed into
// outage-credit accounting/analytics). RADIUS credentials are left alone,
// same reasoning as outage pausing: nothing needs to change there until
// resume, since a paused entitlement simply isn't what's being offered to
// customers while the promo is live.
export async function startPromo(prisma: PrismaClient, input: StartPromoInput): Promise<WifiPromo> {
  const now = new Date();
  const startsAt = input.startsAt ?? now;
  const isLiveImmediately = startsAt.getTime() <= now.getTime();
  const pauseExisting = input.pauseExisting ?? true;

  return prisma.$transaction(async (tx) => {
    const promo = await tx.wifiPromo.create({
      data: {
        siteId: input.siteId,
        active: true,
        heading: input.heading ?? null,
        message: input.message ?? null,
        startsAt,
        activatedAt: isLiveImmediately ? now : null,
        endsAt: input.endsAt,
        rateLimit: input.rateLimit ?? null,
        deviceLimit: input.deviceLimit ?? 1,
        pauseExisting
      }
    });

    if (isLiveImmediately && pauseExisting) {
      await pauseExistingEntitlements(tx, now);
    }

    return promo;
  });
}

// Un-freezes every promo-paused entitlement (crediting back exactly the
// frozen duration, same math as outage credit's resume) and deactivates the
// promo. Safe to call even if pauseExisting was false -- the updateMany
// simply matches zero rows.
export async function endPromo(prisma: PrismaClient, promoId: string): Promise<{ resumed: number }> {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const paused = await tx.wifiEntitlement.findMany({
      where: { promoPausedAt: { not: null } },
      select: {
        id: true,
        customerPhone: true,
        username: true,
        cleartextSecret: true,
        deviceMac: true,
        expiresAt: true,
        rateLimit: true,
        deviceLimit: true,
        promoPausedAt: true
      }
    });

    for (const entitlement of paused) {
      const pausedAt = entitlement.promoPausedAt;
      if (!pausedAt) continue;

      const frozenSeconds = Math.max(0, Math.floor((now.getTime() - pausedAt.getTime()) / 1000));
      const expiresAt = new Date(entitlement.expiresAt.getTime() + frozenSeconds * 1000);

      // status is force-set back to "active" here (not just expiresAt) as a
      // defensive backstop: if expireEntitlements' frozen-clock exclusion
      // ever misses a promoPausedAt row (as it did until this fix), this is
      // what stops that from leaving a customer stuck on "expired" forever
      // even after their time gets correctly credited back.
      await tx.wifiEntitlement.update({
        where: { id: entitlement.id },
        data: { status: "active", expiresAt, promoPausedAt: null }
      });

      // A newer entitlement for this username may have been created while
      // this one was paused (e.g. a fresh purchase) -- same guard
      // resumePausedEntitlements uses for outage credit, so resuming never
      // clobbers a sibling entitlement's live RADIUS credentials.
      if (await hasOtherActiveEntitlement(tx, entitlement.username, entitlement.id, now)) continue;

      const durationSeconds = Math.max(60, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
      const projection = buildRadiusProjection({
        entitlementId: entitlement.id,
        phone: entitlement.customerPhone,
        username: entitlement.username,
        password: entitlement.cleartextSecret,
        deviceMac: entitlement.deviceMac,
        expiresAt,
        durationSeconds,
        rateLimit: entitlement.rateLimit,
        deviceLimit: entitlement.deviceLimit
      });
      await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
      await tx.wifiRadiusProjection.upsert({
        where: { entitlementId: entitlement.id },
        create: {
          entitlementId: entitlement.id,
          username: projection.username,
          checkItems: projection.checkItems,
          replyItems: projection.replyItems,
          status: "applied",
          appliedAt: now
        },
        update: {
          username: projection.username,
          checkItems: projection.checkItems,
          replyItems: projection.replyItems,
          status: "applied",
          appliedAt: now,
          lastError: null
        }
      });
    }

    await tx.wifiPromo.update({ where: { id: promoId }, data: { active: false } });
    return { resumed: paused.length };
  });
}

async function ensurePromoPlan(tx: Prisma.TransactionClient, siteId: string, promo: WifiPromo) {
  return tx.wifiPlan.upsert({
    where: { siteId_source_externalPackageId: { siteId, source: PROMO_PLAN_SOURCE, externalPackageId: PROMO_PLAN_EXTERNAL_ID } },
    create: {
      siteId,
      source: PROMO_PLAN_SOURCE,
      externalPackageId: PROMO_PLAN_EXTERNAL_ID,
      name: promo.heading || "Free Surfing Promo",
      durationSeconds: 3600,
      priceKsh: 0,
      rateLimit: promo.rateLimit,
      deviceLimit: promo.deviceLimit,
      enabled: false
    },
    update: {
      rateLimit: promo.rateLimit,
      deviceLimit: promo.deviceLimit
    }
  });
}

// Grants (or, on a repeat portal visit from the same device, extends
// in-place) free access good until the promo's endsAt -- deliberately
// namespaced under "promo-<mac>" rather than reusing the CAPTYN Welcome
// free flow's "free-<mac>" username, so it never interacts with that
// offer's one-time-ever-per-device block.
export async function claimPromoGrant(prisma: PrismaClient, promo: WifiPromo, deviceMacRaw: string) {
  const deviceMac = normalizeDeviceMac(deviceMacRaw);
  if (!deviceMac) throw new Error("Device MAC required");

  const now = new Date();
  if (now < promo.startsAt) throw new Error("This offer has not started yet");
  if (!promo.activatedAt) throw new Error("This offer is starting. Try again in a moment.");
  if (now >= promo.endsAt) throw new Error("This offer has ended");

  const username = promoUsername(deviceMac);
  const durationSeconds = Math.max(60, Math.floor((promo.endsAt.getTime() - now.getTime()) / 1000));

  return prisma.$transaction(async (tx) => {
    const plan = await ensurePromoPlan(tx, promo.siteId, promo);

    const existing = await tx.wifiEntitlement.findFirst({
      where: { username, status: "active", expiresAt: { gt: now } },
      orderBy: { expiresAt: "desc" }
    });

    const expiresAt = promo.endsAt;
    let entitlementId: string;
    let cleartextSecret: string;

    if (existing) {
      entitlementId = existing.id;
      cleartextSecret = existing.cleartextSecret;
      await tx.wifiEntitlement.update({ where: { id: existing.id }, data: { expiresAt, deviceMac } });
    } else {
      const password = createRadiusSecret();
      const intent = await tx.wifiPaymentIntent.create({
        data: {
          siteId: plan.siteId,
          planId: plan.id,
          source: PROMO_PLAN_SOURCE,
          sourceReference: `promo-${Date.now()}-${deviceMac}`,
          customerPhone: username,
          deviceMac,
          amountKsh: 0,
          provider: "free",
          status: "activated",
          confirmedAt: now
        }
      });
      const created = await tx.wifiEntitlement.create({
        data: {
          siteId: plan.siteId,
          planId: plan.id,
          paymentIntentId: intent.id,
          customerPhone: username,
          username,
          cleartextSecret: password,
          deviceMac,
          status: "active",
          startsAt: now,
          expiresAt,
          deviceLimit: promo.deviceLimit,
          rateLimit: promo.rateLimit
        }
      });
      entitlementId = created.id;
      cleartextSecret = password;
    }

    const projection = buildRadiusProjection({
      entitlementId,
      phone: username,
      username,
      password: cleartextSecret,
      deviceMac,
      expiresAt,
      durationSeconds,
      rateLimit: promo.rateLimit,
      deviceLimit: promo.deviceLimit
    });
    await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
    await tx.wifiRadiusProjection.upsert({
      where: { entitlementId },
      create: {
        entitlementId,
        username: projection.username,
        checkItems: projection.checkItems,
        replyItems: projection.replyItems,
        status: "applied",
        appliedAt: now
      },
      update: {
        username: projection.username,
        checkItems: projection.checkItems,
        replyItems: projection.replyItems,
        status: "applied",
        appliedAt: now,
        lastError: null
      }
    });

    return { username, password: cleartextSecret, expiresAt };
  });
}
