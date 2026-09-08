import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { config } from "../config.js";
import { getMpesaStatus } from "../services/mpesa.js";
import { buildRadiusProjection, normalizeDeviceMac, normalizeWifiUsername } from "../services/radiusProjection.js";
import { applyRadiusProjectionRows, hasOtherActiveEntitlement } from "../services/radiusSqlApply.js";
import { kickHotspotUser } from "../services/routeros.js";
import { issueVoucher } from "../services/voucherIssuance.js";
import { normalizeKenyaPhone } from "../lib/phone.js";
import { endPromo, getActivePromo, startPromo } from "../services/promo.js";
import { CREDIT_REASONS, availableCreditSeconds, grantWifiCredit } from "../services/credits.js";

export const adminRouter = Router();

// src/routes/admin.ts -> dist/routes/admin.js at runtime, so public/ is two
// levels up, same computation server.ts uses for its own publicDir.
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const planImagesDir = path.join(publicDir, "uploads", "plan-images");
const ACCEPTED_IMAGE_FORMATS = ["jpeg", "png", "webp"] as const;
const planImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional()
);

const mikrotikRateLimit = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .regex(/^\d+(?:[kKmM])?\/\d+(?:[kKmM])?$/, "Use MikroTik upload/download format, for example 5M/10M or 512k/2M.")
    .optional()
);

const siteCreateSchema = z.object({
  name: z.string().trim().min(1),
  externalId: optionalText,
  source: optionalText.default("captyn_admin")
});

const siteUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  externalId: optionalText,
  source: optionalText
});

const planCategorySchema = z.enum(["standard", "limited"]);

const planCreateSchema = z.object({
  siteId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  externalPackageId: optionalText,
  durationSeconds: z.coerce.number().int().positive(),
  priceKsh: z.coerce.number().int().nonnegative(),
  category: planCategorySchema.default("standard"),
  rateLimit: mikrotikRateLimit,
  deviceLimit: z.coerce.number().int().positive().default(1),
  enabled: z.coerce.boolean().default(true),
  source: optionalText.default("captyn_admin"),
  featured: z.coerce.boolean().default(false),
  manualPricing: z.coerce.boolean().default(false)
});

const planUpdateSchema = planCreateSchema.partial().extend({ enabled: z.coerce.boolean().optional() });

const voucherCreateSchema = z.object({
  planId: z.string().trim().min(1),
  customerPhone: optionalText,
  deviceMac: optionalText.nullable().optional()
});

const nullableMikrotikRateLimit = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string()
    .trim()
    .regex(/^\d+(?:[kKmM])?\/\d+(?:[kKmM])?$/, "Use MikroTik upload/download format, for example 5M/10M or 512k/2M.")
    .nullable()
    .optional()
);

const entitlementActionSchema = z.object({
  action: z.enum(["sync_package_settings", "update_limits", "reapply_radius", "extend", "suspend", "reactivate", "expire"]),
  extensionSeconds: z.coerce.number().int().positive().max(366 * 24 * 60 * 60).optional(),
  rateLimit: nullableMikrotikRateLimit,
  deviceLimit: z.coerce.number().int().positive().max(50).optional()
});

const MAX_BULK_VOUCHER_RECIPIENTS = 200;

const bulkVoucherCreateSchema = z.object({
  planId: z.string().trim().min(1),
  phones: z.array(z.string().trim().min(1)).min(1).max(MAX_BULK_VOUCHER_RECIPIENTS),
  deviceMac: optionalText.nullable().optional()
});

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
    )
  );
}

function sendData(res: import("express").Response, data: unknown) {
  return res.json({ data: toJsonSafe(data) });
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function externalPackageIdFor(input: { name: string; durationSeconds: number; priceKsh: number }) {
  const base = slugify(input.name) || "wifi-plan";
  return `${base}-${input.durationSeconds}s-${input.priceKsh}kes`;
}


type NetworkState = "ok" | "warn" | "bad" | "idle";

function countValue(rows: Array<{ count: bigint | number | string }>) {
  const value = rows[0]?.count ?? 0;
  return Number(value);
}

async function rawCount(query: Prisma.Sql) {
  try {
    const rows = await prisma.$queryRaw<Array<{ count: bigint | number | string }>>(query);
    return { ok: true, count: countValue(rows), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "SQL check failed";
    return { ok: false, count: 0, error: message };
  }
}

function pipelineItem(id: string, label: string, state: NetworkState, detail: string) {
  return { id, label, state, detail };
}

async function applyEntitlementRadius(
  tx: Prisma.TransactionClient,
  entitlement: {
    id: string;
    customerPhone: string;
    username: string;
    cleartextSecret: string;
    deviceMac: string | null;
    status: string;
    expiresAt: Date;
    rateLimit: string | null;
    deviceLimit: number;
    projection: { id: string } | null;
  },
  at = new Date()
) {
  const isActive = entitlement.status === "active" && entitlement.expiresAt > at;
  if (!isActive) {
    const keepRows = await hasOtherActiveEntitlement(tx, entitlement.username, entitlement.id, at);
    if (!keepRows) {
      await tx.$executeRaw`DELETE FROM radcheck WHERE username = ${entitlement.username}`;
      await tx.$executeRaw`DELETE FROM radreply WHERE username = ${entitlement.username}`;
    }
    if (entitlement.projection) {
      await tx.wifiRadiusProjection.update({
        where: { id: entitlement.projection.id },
        data: { status: "applied", lastError: null, appliedAt: at }
      });
    }
    return entitlement.projection;
  }

  const durationSeconds = Math.max(60, Math.round((entitlement.expiresAt.getTime() - at.getTime()) / 1000));
  const projection = buildRadiusProjection({
    entitlementId: entitlement.id,
    phone: entitlement.customerPhone,
    username: entitlement.username,
    password: entitlement.cleartextSecret,
    deviceMac: entitlement.deviceMac,
    expiresAt: entitlement.expiresAt,
    durationSeconds,
    rateLimit: entitlement.rateLimit,
    deviceLimit: entitlement.deviceLimit
  });

  await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
  if (entitlement.projection) {
    return tx.wifiRadiusProjection.update({
      where: { id: entitlement.projection.id },
      data: {
        username: projection.username,
        checkItems: projection.checkItems,
        replyItems: projection.replyItems,
        status: "applied",
        lastError: null,
        appliedAt: at
      }
    });
  }

  return tx.wifiRadiusProjection.create({
    data: {
      entitlementId: entitlement.id,
      username: projection.username,
      checkItems: projection.checkItems,
      replyItems: projection.replyItems,
      status: "applied",
      appliedAt: at
    }
  });
}

adminRouter.get("/summary", async (_req, res, next) => {
  try {
    const now = new Date();
    const [
      siteCount,
      planCount,
      activeEntitlementCount,
      expiredEntitlementCount,
      pendingProjectionCount,
      failedProjectionCount,
      paymentCount,
      revenue,
      recentPayments,
      recentEntitlements,
      recentProjections
    ] = await Promise.all([
      prisma.wifiSite.count(),
      prisma.wifiPlan.count(),
      prisma.wifiEntitlement.count({
        where: { status: "active", expiresAt: { gt: now } }
      }),
      prisma.wifiEntitlement.count({
        where: { OR: [{ status: "expired" }, { expiresAt: { lte: now } }] }
      }),
      prisma.wifiRadiusProjection.count({ where: { status: "pending" } }),
      prisma.wifiRadiusProjection.count({ where: { status: "failed" } }),
      prisma.wifiPaymentIntent.count(),
      prisma.wifiPaymentIntent.aggregate({
        where: { status: { in: ["confirmed", "paid_pending_activation", "activated"] } },
        _sum: { amountKsh: true }
      }),
      prisma.wifiPaymentIntent.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { site: true, plan: true }
      }),
      prisma.wifiEntitlement.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { site: true, plan: true, projection: true }
      }),
      prisma.wifiRadiusProjection.findMany({
        orderBy: { updatedAt: "desc" },
        take: 8,
        include: { entitlement: { include: { site: true, plan: true } } }
      })
    ]);

    return sendData(res, {
      generatedAt: now.toISOString(),
      metrics: {
        siteCount,
        planCount,
        activeEntitlementCount,
        expiredEntitlementCount,
        pendingProjectionCount,
        failedProjectionCount,
        paymentCount,
        revenueKsh: revenue._sum.amountKsh ?? 0
      },
      recentPayments,
      recentEntitlements,
      recentProjections
    });
  } catch (error) {
    return next(error);
  }
});


adminRouter.get("/network-status", async (_req, res, next) => {
  try {
    const now = new Date();
    const stalePaymentCutoff = new Date(now.getTime() - 15 * 60 * 1000);
    const recentAccountingCutoff = new Date(now.getTime() - 30 * 60 * 1000);
    const mpesa = getMpesaStatus();

    const [
      siteCount,
      publishedPlanCount,
      paymentCount,
      pendingPaymentCount,
      stalePendingPaymentCount,
      activeEntitlementCount,
      activeWithoutProjectionCount,
      pendingProjectionCount,
      failedProjectionCount,
      appliedProjectionCount,
      accountingSessionCount,
      recentAccountingCount,
      radcheck,
      radreply,
      activeAppliedMissingRadiusRows,
      activeWithAccountingCount,
      activeWithRecentAccountingCount,
      radacctCount,
      recentRadacctCount,
      activeWithRadacctCount,
      activeWithRecentRadacctCount
    ] = await Promise.all([
      prisma.wifiSite.count(),
      prisma.wifiPlan.count({ where: { enabled: true } }),
      prisma.wifiPaymentIntent.count(),
      prisma.wifiPaymentIntent.count({ where: { status: "pending_confirmation" } }),
      prisma.wifiPaymentIntent.count({ where: { status: "pending_confirmation", updatedAt: { lt: stalePaymentCutoff } } }),
      prisma.wifiEntitlement.count({ where: { status: "active", expiresAt: { gt: now } } }),
      prisma.wifiEntitlement.count({ where: { status: "active", expiresAt: { gt: now }, projection: null } }),
      prisma.wifiRadiusProjection.count({ where: { status: "pending" } }),
      prisma.wifiRadiusProjection.count({ where: { status: "failed" } }),
      prisma.wifiRadiusProjection.count({ where: { status: "applied" } }),
      prisma.wifiAccountingSession.count(),
      prisma.wifiAccountingSession.count({
        where: { OR: [{ updatedAt: { gt: recentAccountingCutoff } }, { lastInterimAt: { gt: recentAccountingCutoff } }] }
      }),
      rawCount(Prisma.sql`select count(*)::bigint as count from radcheck`),
      rawCount(Prisma.sql`select count(*)::bigint as count from radreply`),
      rawCount(Prisma.sql`
        select count(*)::bigint as count
        from "WifiEntitlement" entitlement
        join "WifiRadiusProjection" projection on projection."entitlementId" = entitlement.id
        left join radcheck check_row on check_row.username = projection.username
        where entitlement.status = 'active'
          and entitlement."expiresAt" > ${now}
          and projection.status = 'applied'
          and check_row.id is null
      `),
      rawCount(Prisma.sql`
        select count(distinct entitlement.username)::bigint as count
        from "WifiEntitlement" entitlement
        join "WifiAccountingSession" accounting on accounting.username = entitlement.username
        where entitlement.status = 'active'
          and entitlement."expiresAt" > ${now}
      `),
      rawCount(Prisma.sql`
        select count(distinct entitlement.username)::bigint as count
        from "WifiEntitlement" entitlement
        join "WifiAccountingSession" accounting on accounting.username = entitlement.username
        where entitlement.status = 'active'
          and entitlement."expiresAt" > ${now}
          and (accounting."updatedAt" > ${recentAccountingCutoff} or accounting."lastInterimAt" > ${recentAccountingCutoff})
      `),
      rawCount(Prisma.sql`select count(*)::bigint as count from radacct`),
      rawCount(Prisma.sql`
        select count(*)::bigint as count
        from radacct
        where coalesce(acctupdatetime, acctstarttime) > ${recentAccountingCutoff}
      `),
      rawCount(Prisma.sql`
        select count(distinct entitlement.username)::bigint as count
        from "WifiEntitlement" entitlement
        join radacct accounting on accounting.username = entitlement.username
        where entitlement.status = 'active'
          and entitlement."expiresAt" > ${now}
      `),
      rawCount(Prisma.sql`
        select count(distinct entitlement.username)::bigint as count
        from "WifiEntitlement" entitlement
        join radacct accounting on accounting.username = entitlement.username
        where entitlement.status = 'active'
          and entitlement."expiresAt" > ${now}
          and (coalesce(accounting.acctupdatetime, accounting.acctstarttime) > ${recentAccountingCutoff} or accounting.acctstoptime is null)
      `)
    ]);

    const radiusSqlHealthy = radcheck.ok && radreply.ok && activeAppliedMissingRadiusRows.ok;
    const accountingHealthy = activeWithAccountingCount.ok && activeWithRecentAccountingCount.ok && radacctCount.ok && recentRadacctCount.ok && activeWithRadacctCount.ok && activeWithRecentRadacctCount.ok;
    const activeAccountingCount = Math.max(activeWithRadacctCount.count, activeWithAccountingCount.count);
    const activeRecentAccountingCount = Math.max(activeWithRecentRadacctCount.count, activeWithRecentAccountingCount.count);
    const pipeline = [
      pipelineItem(
        "portal",
        "Client portal",
        publishedPlanCount > 0 ? "ok" : "warn",
        publishedPlanCount > 0
          ? `${publishedPlanCount} package${publishedPlanCount === 1 ? "" : "s"} published for customers.`
          : "No enabled package is visible to customers."
      ),
      pipelineItem(
        "mpesa",
        "M-PESA checkout",
        mpesa.configured ? "ok" : mpesa.enabled ? "warn" : "bad",
        mpesa.configured
          ? "Checkout configuration is present."
          : mpesa.enabled
            ? `Missing ${mpesa.missing.join(", ")}.`
            : "Checkout is disabled in configuration."
      ),
      pipelineItem(
        "payments",
        "Payment confirmations",
        stalePendingPaymentCount > 0 ? "warn" : "ok",
        stalePendingPaymentCount > 0
          ? `${stalePendingPaymentCount} pending payment${stalePendingPaymentCount === 1 ? "" : "s"} older than 15 minutes.`
          : `${pendingPaymentCount} payment${pendingPaymentCount === 1 ? "" : "s"} waiting now.`
      ),
      pipelineItem(
        "entitlements",
        "Access creation",
        activeWithoutProjectionCount > 0 ? "warn" : activeEntitlementCount > 0 || paymentCount === 0 ? "ok" : "idle",
        activeWithoutProjectionCount > 0
          ? `${activeWithoutProjectionCount} active access record${activeWithoutProjectionCount === 1 ? "" : "s"} missing RADIUS projection.`
          : `${activeEntitlementCount} active access record${activeEntitlementCount === 1 ? "" : "s"}.`
      ),
      pipelineItem(
        "projection",
        "RADIUS worker",
        failedProjectionCount > 0 ? "bad" : pendingProjectionCount > 0 ? "warn" : appliedProjectionCount > 0 || activeEntitlementCount === 0 ? "ok" : "idle",
        failedProjectionCount > 0
          ? `${failedProjectionCount} RADIUS projection${failedProjectionCount === 1 ? "" : "s"} failed.`
          : pendingProjectionCount > 0
            ? `${pendingProjectionCount} projection${pendingProjectionCount === 1 ? "" : "s"} waiting for worker.`
            : `${appliedProjectionCount} projection${appliedProjectionCount === 1 ? "" : "s"} applied.`
      ),
      pipelineItem(
        "radius_sql",
        "FreeRADIUS SQL rows",
        !radiusSqlHealthy ? "bad" : activeAppliedMissingRadiusRows.count > 0 ? "bad" : radcheck.count > 0 || activeEntitlementCount === 0 ? "ok" : "warn",
        !radiusSqlHealthy
          ? "RADIUS SQL tables could not be read."
          : activeAppliedMissingRadiusRows.count > 0
            ? `${activeAppliedMissingRadiusRows.count} active access projection${activeAppliedMissingRadiusRows.count === 1 ? "" : "s"} missing radcheck rows.`
            : `${radcheck.count} check row${radcheck.count === 1 ? "" : "s"}, ${radreply.count} reply row${radreply.count === 1 ? "" : "s"}.`
      ),
      pipelineItem(
        "router_accounting",
        "MikroTik accounting",
        !accountingHealthy ? "bad" : activeRecentAccountingCount > 0 ? "ok" : activeEntitlementCount > 0 ? "warn" : "idle",
        !accountingHealthy
          ? "Router accounting tables could not be read."
          : activeRecentAccountingCount > 0
            ? `${activeRecentAccountingCount} active user${activeRecentAccountingCount === 1 ? "" : "s"} with recent router accounting.`
            : activeAccountingCount > 0
              ? `${activeAccountingCount} active user${activeAccountingCount === 1 ? "" : "s"} with router accounting, none recent.`
              : activeEntitlementCount > 0
                ? "No router accounting received for current active access."
                : "No active access waiting for accounting."
      )
    ];

    return sendData(res, {
      generatedAt: now.toISOString(),
      metrics: {
        siteCount,
        publishedPlanCount,
        paymentCount,
        pendingPaymentCount,
        stalePendingPaymentCount,
        activeEntitlementCount,
        activeWithoutProjectionCount,
        pendingProjectionCount,
        failedProjectionCount,
        appliedProjectionCount,
        radcheckCount: radcheck.count,
        radreplyCount: radreply.count,
        appliedMissingRadiusRowsCount: activeAppliedMissingRadiusRows.count,
        accountingSessionCount,
        recentAccountingCount,
        radacctCount: radacctCount.count,
        recentRadacctCount: recentRadacctCount.count,
        activeWithAccountingCount: activeAccountingCount,
        activeWithRecentAccountingCount: activeRecentAccountingCount,
        appMirrorActiveWithAccountingCount: activeWithAccountingCount.count,
        appMirrorActiveWithRecentAccountingCount: activeWithRecentAccountingCount.count
      },
      mpesa: { enabled: mpesa.enabled, configured: mpesa.configured, missing: mpesa.configured ? [] : mpesa.missing },
      radiusSql: { ok: radiusSqlHealthy, errors: [radcheck, radreply, activeAppliedMissingRadiusRows].filter((item) => !item.ok).map((item) => item.error) },
      pipeline
    });
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/sites", async (_req, res, next) => {
  try {
    const data = await prisma.wifiSite.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { plans: true, intents: true, entitlements: true } }
      }
    });
    return sendData(res, data);
  } catch (error) {
    return next(error);
  }
});

adminRouter.post("/sites", async (req, res, next) => {
  try {
    const data = siteCreateSchema.parse(req.body);
    const id = crypto.randomUUID();
    const site = await prisma.wifiSite.create({
      data: {
        id,
        name: data.name,
        source: data.source,
        externalId: data.externalId ?? id
      },
      include: { _count: { select: { plans: true, intents: true, entitlements: true } } }
    });
    return sendData(res.status(201), site);
  } catch (error) {
    return next(error);
  }
});

adminRouter.patch("/sites/:id", async (req, res, next) => {
  try {
    const data = siteUpdateSchema.parse(req.body);
    const site = await prisma.wifiSite.update({
      where: { id: req.params.id },
      data,
      include: { _count: { select: { plans: true, intents: true, entitlements: true } } }
    });
    return sendData(res, site);
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/plans", async (_req, res, next) => {
  try {
    const data = await prisma.wifiPlan.findMany({
      orderBy: [{ siteId: "asc" }, { priceKsh: "asc" }, { durationSeconds: "asc" }, { name: "asc" }],
      include: { site: true }
    });
    return sendData(res, data);
  } catch (error) {
    return next(error);
  }
});

adminRouter.post("/plans", async (req, res, next) => {
  try {
    const data = planCreateSchema.parse(req.body);
    const plan = await prisma.wifiPlan.create({
      data: {
        siteId: data.siteId,
        source: data.source,
        externalPackageId: data.externalPackageId ?? externalPackageIdFor(data),
        name: data.name,
        durationSeconds: data.durationSeconds,
        priceKsh: data.priceKsh,
        category: data.category,
        rateLimit: data.rateLimit,
        deviceLimit: data.deviceLimit,
        enabled: data.enabled,
        featured: data.featured,
        manualPricing: data.manualPricing
      },
      include: { site: true }
    });
    return sendData(res.status(201), plan);
  } catch (error) {
    return next(error);
  }
});

adminRouter.patch("/plans/:id", async (req, res, next) => {
  try {
    const data = planUpdateSchema.parse(req.body);
    const plan = await prisma.$transaction(async (tx) => {
      const updated = await tx.wifiPlan.update({
        where: { id: req.params.id },
        data: {
          ...(data.siteId !== undefined ? { siteId: data.siteId } : {}),
          ...(data.source !== undefined ? { source: data.source } : {}),
          ...(data.externalPackageId !== undefined ? { externalPackageId: data.externalPackageId } : {}),
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}),
          ...(data.priceKsh !== undefined ? { priceKsh: data.priceKsh } : {}),
          ...(data.category !== undefined ? { category: data.category } : {}),
          ...(data.rateLimit !== undefined ? { rateLimit: data.rateLimit } : {}),
          ...(data.deviceLimit !== undefined ? { deviceLimit: data.deviceLimit } : {}),
          ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
          ...(data.featured !== undefined ? { featured: data.featured } : {}),
          ...(data.manualPricing !== undefined ? { manualPricing: data.manualPricing } : {})
        },
        include: { site: true }
      });

      // If this plan is (now) manually priced, make sure no stale
      // captyn_dynamic mirror is still hanging around from before it opted
      // in -- dynamicPlanEngine's rotation loop excludes manualPricing
      // plans from mirroring going forward, but never revisits or deletes a
      // mirror it already created. Left alone, that mirror would keep
      // showing (and stay purchasable) at its last auto-flexed price
      // alongside the admin's new pinned price. deleteMany is a safe no-op
      // when no mirror exists.
      if (updated.manualPricing) {
        await tx.wifiPlan.deleteMany({
          where: { siteId: updated.siteId, source: "captyn_dynamic", externalPackageId: updated.id }
        });
      }

      return updated;
    });
    return sendData(res, plan);
  } catch (error) {
    return next(error);
  }
});

adminRouter.post("/plans/:id/image", planImageUpload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image file provided." });

    const plan = await prisma.wifiPlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Package not found" });

    // Standard prebuilt sharp/libvips binaries don't decode HEIC/HEIF --
    // iPhone camera photos are HEIC by default, so this is the realistic
    // main error path for "upload a real photo of the package," not edge
    // -case polish. sharp() itself just throws on an unreadable buffer, so
    // wrap metadata() rather than let that surface as a raw 500.
    let format: string | undefined;
    try {
      format = (await sharp(req.file.buffer).metadata()).format;
    } catch {
      // fall through to the format check below with format left undefined
    }
    if (!format || !ACCEPTED_IMAGE_FORMATS.includes(format as (typeof ACCEPTED_IMAGE_FORMATS)[number])) {
      return res.status(400).json({
        error:
          "Please upload a JPEG, PNG, or WebP image. HEIC photos straight off an iPhone aren't supported -- export or share it as a JPEG first."
      });
    }

    // This is a captive-portal card image, loaded during initial hotspot
    // association where every extra KB matters -- resize well past the
    // card's actual rendered size (480x270 vs. ~170px-wide grid cards, so
    // still sharp at 2x/retina) and step quality down until it's genuinely
    // small, not just "smaller than the original."
    let quality = 70;
    let output: Buffer;
    do {
      output = await sharp(req.file.buffer)
        .resize({ width: 480, height: 270, fit: "inside", withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
      quality -= 15;
    } while (output.byteLength > 30 * 1024 && quality >= 25);

    await fs.mkdir(planImagesDir, { recursive: true });
    const filename = `${plan.id}-${Date.now()}.webp`;
    await fs.writeFile(path.join(planImagesDir, filename), output);

    const updated = await prisma.wifiPlan.update({
      where: { id: plan.id },
      data: { imageFile: filename },
      include: { site: true }
    });

    if (plan.imageFile) {
      await fs.rm(path.join(planImagesDir, plan.imageFile), { force: true });
    }

    return sendData(res, updated);
  } catch (error) {
    return next(error);
  }
});

adminRouter.delete("/plans/:id", async (req, res, next) => {
  try {
    const deleted = await prisma.wifiPlan.delete({ where: { id: req.params.id } });
    if (deleted.imageFile) {
      await fs.rm(path.join(planImagesDir, deleted.imageFile), { force: true });
    }
    return sendData(res, deleted);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") return res.status(404).json({ error: "Package not found" });
      // WifiPaymentIntent.planId / WifiEntitlement.planId are onDelete:
      // Restrict -- any package that's ever been paid for or granted access
      // through hits this, and that's the point: deleting it out from under
      // real payment/access history would be a correctness bug, not a
      // convenience. Uncheck Published instead to hide it from customers.
      if (error.code === "P2003") {
        return res.status(409).json({
          error: "This package has payment or access history and can't be deleted -- uncheck Published to hide it from customers instead."
        });
      }
    }
    return next(error);
  }
});

adminRouter.get("/payment-intents", async (_req, res, next) => {
  try {
    const data = await prisma.wifiPaymentIntent.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { site: true, plan: true, entitlement: true }
    });
    return sendData(res, data);
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/entitlements", async (_req, res, next) => {
  try {
    const data = await prisma.wifiEntitlement.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { site: true, plan: true, projection: true }
    });
    return sendData(res, data);
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/entitlements/:id", async (req, res, next) => {
  try {
    const entitlement = await prisma.wifiEntitlement.findUnique({
      where: { id: req.params.id },
      include: { site: true, plan: true, projection: true, paymentIntent: true }
    });
    if (!entitlement) return res.status(404).json({ error: "Access record not found" });

    const [accounting, radcheck, radreply] = await Promise.all([
      prisma.wifiAccountingSession.findMany({ where: { username: entitlement.username }, orderBy: { updatedAt: "desc" }, take: 5 }),
      prisma.$queryRaw<Array<{ attribute: string; op: string; value: string }>>`select attribute, op, value from radcheck where username = ${entitlement.username} order by id`,
      prisma.$queryRaw<Array<{ attribute: string; op: string; value: string }>>`select attribute, op, value from radreply where username = ${entitlement.username} order by id`
    ]);

    return sendData(res, { entitlement, accounting, radcheck, radreply });
  } catch (error) {
    return next(error);
  }
});

adminRouter.post("/entitlements/:id/actions", async (req, res, next) => {
  try {
    const data = entitlementActionSchema.parse(req.body);
    const now = new Date();
    let affectedUsername = "";

    await prisma.$transaction(async (tx) => {
      const entitlement = await tx.wifiEntitlement.findUnique({
        where: { id: req.params.id },
        include: { plan: true, projection: true }
      });
      if (!entitlement) throw new Error("ACCESS_RECORD_NOT_FOUND");
      affectedUsername = entitlement.username;

      if (data.action === "expire") {
        const updated = await tx.wifiEntitlement.update({
          where: { id: entitlement.id },
          data: { status: "expired", expiresAt: now },
          include: { projection: true }
        });
        await applyEntitlementRadius(tx, updated, now);
        return;
      }

      const patch: { status?: "active" | "suspended"; expiresAt?: Date; rateLimit?: string | null; deviceLimit?: number; acctInterimSeconds?: number } = {};
      if (data.action === "extend") {
        if (!data.extensionSeconds) throw new Error("EXTENSION_SECONDS_REQUIRED");
        const base = entitlement.expiresAt > now ? entitlement.expiresAt : now;
        patch.status = "active";
        patch.expiresAt = new Date(base.getTime() + data.extensionSeconds * 1000);
      }
      if (data.action === "sync_package_settings") {
        patch.rateLimit = entitlement.plan.rateLimit;
        patch.deviceLimit = entitlement.plan.deviceLimit;
        patch.acctInterimSeconds = config.defaultAcctInterimSeconds;
      }
      if (data.action === "update_limits") {
        if (data.rateLimit !== undefined) patch.rateLimit = data.rateLimit;
        if (data.deviceLimit !== undefined) patch.deviceLimit = data.deviceLimit;
      }
      if (data.action === "suspend") {
        patch.status = "suspended";
      }
      if (data.action === "reactivate") {
        patch.status = "active";
        if (entitlement.expiresAt <= now) patch.expiresAt = new Date(now.getTime() + entitlement.plan.durationSeconds * 1000);
      }

      const updated = Object.keys(patch).length
        ? await tx.wifiEntitlement.update({ where: { id: entitlement.id }, data: patch, include: { projection: true } })
        : entitlement;
      await applyEntitlementRadius(tx, updated, now);
    });

    const [refreshed, router] = await Promise.all([
      prisma.wifiEntitlement.findUnique({
        where: { id: req.params.id },
        include: { site: true, plan: true, projection: true, paymentIntent: true }
      }),
      affectedUsername ? kickHotspotUser(affectedUsername) : Promise.resolve(null)
    ]);
    return sendData(res, { entitlement: refreshed, router });
  } catch (error) {
    if (error instanceof Error && error.message === "ACCESS_RECORD_NOT_FOUND") return res.status(404).json({ error: "Access record not found" });
    if (error instanceof Error && error.message === "EXTENSION_SECONDS_REQUIRED") return res.status(400).json({ error: "Choose how much time to add." });
    return next(error);
  }
});

adminRouter.post("/vouchers", async (req, res, next) => {
  try {
    const data = voucherCreateSchema.parse(req.body);
    const plan = await prisma.wifiPlan.findUnique({ where: { id: data.planId } });
    if (!plan) return res.status(404).json({ error: "Package not found" });

    const issued = await issueVoucher(plan, {
      customerPhone: data.customerPhone ? normalizeKenyaPhone(data.customerPhone) : undefined,
      deviceMac: data.deviceMac ?? null
    });

    return res.status(201).json({
      data: {
        entitlement: issued.entitlement,
        code: issued.code,
        expiresAt: issued.expiresAt
      }
    });
  } catch (error) {
    return next(error);
  }
});

adminRouter.post("/vouchers/bulk", async (req, res, next) => {
  try {
    const data = bulkVoucherCreateSchema.parse(req.body);
    const plan = await prisma.wifiPlan.findUnique({ where: { id: data.planId } });
    if (!plan) return res.status(404).json({ error: "Package not found" });

    const uniquePhones = [...new Set(data.phones.map((phone) => normalizeKenyaPhone(phone)).filter(Boolean))];

    const results: Array<
      | { phone: string; status: "created"; code: string; expiresAt: Date }
      | { phone: string; status: "failed"; error: string }
    > = [];

    for (const phone of uniquePhones) {
      try {
        const issued = await issueVoucher(plan, { customerPhone: phone, deviceMac: data.deviceMac ?? null });
        results.push({ phone, status: "created", code: issued.code, expiresAt: issued.expiresAt });
      } catch (error) {
        results.push({
          phone,
          status: "failed",
          error: error instanceof Error ? error.message : "Voucher creation failed"
        });
      }
    }

    const created = results.filter((item) => item.status === "created").length;
    return res.status(201).json({
      data: {
        results,
        summary: { created, failed: results.length - created }
      }
    });
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/radius-projections", async (_req, res, next) => {
  try {
    const data = await prisma.wifiRadiusProjection.findMany({
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      take: 100,
      include: { entitlement: { include: { site: true, plan: true } } }
    });
    return sendData(res, data);
  } catch (error) {
    return next(error);
  }
});


adminRouter.get("/governor-status", async (_req, res, next) => {
  try {
    const [latestRows, stateRows, recentEvents] = await Promise.all([
      prisma.$queryRaw<Array<{
        state: string;
        dryRun: boolean;
        activeSessionCount: number;
        activeDemandMbps: number;
        utilizationScore: number;
        reason: string;
        createdAt: Date;
      }>>(Prisma.sql`
        select
          state,
          "dryRun",
          "activeSessionCount",
          "activeDemandMbps",
          "utilizationScore",
          reason,
          "createdAt"
        from "WifiGovernorEvent"
        order by "createdAt" desc
        limit 1
      `),
      prisma.$queryRaw<Array<{
        state: string;
        events: bigint | number;
        maxActive: number | null;
        maxDemandMbps: number | null;
        maxUtilization: number | null;
        firstSeen: Date | null;
        lastSeen: Date | null;
      }>>(Prisma.sql`
        select
          state,
          count(*) as events,
          max("activeSessionCount") as "maxActive",
          max("activeDemandMbps") as "maxDemandMbps",
          max("utilizationScore") as "maxUtilization",
          min("createdAt") as "firstSeen",
          max("createdAt") as "lastSeen"
        from "WifiGovernorEvent"
        where "createdAt" >= now() - interval '24 hours'
        group by state
        order by max("createdAt") desc
      `),
      prisma.$queryRaw<Array<{
        state: string;
        dryRun: boolean;
        activeSessionCount: number;
        activeDemandMbps: number;
        utilizationScore: number;
        username: string | null;
        previousRateLimit: string | null;
        targetRateLimit: string | null;
        reason: string;
        createdAt: Date;
      }>>(Prisma.sql`
        select
          state,
          "dryRun",
          "activeSessionCount",
          "activeDemandMbps",
          "utilizationScore",
          username,
          "previousRateLimit",
          "targetRateLimit",
          reason,
          "createdAt"
        from "WifiGovernorEvent"
        order by "createdAt" desc
        limit 60
      `)
    ]);

    const latest = latestRows[0] ?? null;
    const totals = stateRows.reduce(
      (acc, row) => {
        const events = Number(row.events || 0);
        return {
          events: acc.events + events,
          maxActive: Math.max(acc.maxActive, Number(row.maxActive || 0)),
          maxDemandMbps: Math.max(acc.maxDemandMbps, Number(row.maxDemandMbps || 0)),
          maxUtilization: Math.max(acc.maxUtilization, Number(row.maxUtilization || 0))
        };
      },
      { events: 0, maxActive: 0, maxDemandMbps: 0, maxUtilization: 0 }
    );

    return sendData(res, {
      generatedAt: new Date(),
      config: {
        enabled: config.governor.enabled,
        dryRun: config.governor.dryRun,
        applyRadiusSql: config.governor.applyRadiusSql,
        kickOnChange: config.governor.kickOnChange,
        pollIntervalMs: config.governor.pollIntervalMs,
        activeWindowSeconds: config.governor.activeWindowSeconds,
        wanDownloadMbps: config.governor.wanDownloadMbps,
        wanUploadMbps: config.governor.wanUploadMbps
      },
      latest,
      totals,
      stateRows,
      recentEvents
    });
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/dynamic-plan-status", async (_req, res, next) => {
  try {
    const [latest, recentEvents, dynamicPlans] = await Promise.all([
      prisma.wifiDynamicPlanEvent.findFirst({ orderBy: { createdAt: "desc" } }),
      prisma.wifiDynamicPlanEvent.findMany({ orderBy: { createdAt: "desc" }, take: 60 }),
      prisma.wifiPlan.findMany({ where: { source: "captyn_dynamic" }, include: { site: true } })
    ]);

    return sendData(res, {
      generatedAt: new Date(),
      config: {
        enabled: config.dynamicPlan.enabled,
        dryRun: config.dynamicPlan.dryRun,
        rotationMs: config.dynamicPlan.rotationMs
      },
      latest,
      dynamicPlans,
      recentEvents
    });
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/outage-credits", async (_req, res, next) => {
  try {
    const [recentCredits, heartbeats, currentlyPaused] = await Promise.all([
      prisma.$queryRaw<Array<{
        id: string;
        service: string;
        outageStartedAt: Date;
        outageEndedAt: Date;
        creditedSeconds: number;
        affectedEntitlements: number;
        entitlementId: string | null;
        createdAt: Date;
      }>>(Prisma.sql`
        select id, service, "outageStartedAt", "outageEndedAt", "creditedSeconds", "affectedEntitlements", "entitlementId", "createdAt"
        from "WifiOutageCredit"
        order by "createdAt" desc
        limit 60
      `),
      prisma.$queryRaw<Array<{ service: string; lastSeenAt: Date; updatedAt: Date }>>(Prisma.sql`
        select service, "lastSeenAt", "updatedAt" from "WifiServiceHeartbeat" order by service asc
      `),
      prisma.wifiEntitlement.findMany({
        where: { outagePausedAt: { not: null } },
        orderBy: { outagePausedAt: "asc" },
        select: { id: true, username: true, customerPhone: true, outagePausedAt: true, outagePauseCause: true, expiresAt: true }
      })
    ]);

    return sendData(res, {
      generatedAt: new Date(),
      config: {
        enabled: config.outageCredit.enabled,
        graceSeconds: config.outageCredit.graceSeconds,
        accountingGraceSeconds: config.outageCredit.accountingGraceSeconds,
        maxCreditSeconds: config.outageCredit.maxCreditSeconds
      },
      heartbeats,
      currentlyPaused,
      recentCredits
    });
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/accounting-sessions", async (_req, res, next) => {
  try {
    const rows = await prisma.$queryRaw<Array<{
      username: string;
      acctSessionId: string;
      callingStationId: string | null;
      nasIpAddress: string | null;
      framedIpAddress: string | null;
      acctSessionTimeSeconds: bigint | number | null;
      inputOctets: bigint | number | null;
      outputOctets: bigint | number | null;
      updatedAt: Date | null;
    }>>(Prisma.sql`
      select
        username,
        acctsessionid as "acctSessionId",
        callingstationid as "callingStationId",
        nasipaddress::text as "nasIpAddress",
        framedipaddress::text as "framedIpAddress",
        acctsessiontime as "acctSessionTimeSeconds",
        acctinputoctets as "inputOctets",
        acctoutputoctets as "outputOctets",
        coalesce(acctupdatetime, acctstoptime, acctstarttime) as "updatedAt"
      from radacct
      order by coalesce(acctupdatetime, acctstoptime, acctstarttime) desc nulls last
      limit 100
    `);
    return sendData(res, rows);
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/promo", async (_req, res, next) => {
  try {
    const promo = await getActivePromo(prisma);
    return sendData(res, promo);
  } catch (error) {
    return next(error);
  }
});

const startPromoSchema = z.object({
  siteId: z.string().min(1),
  heading: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(500).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date(),
  rateLimit: z.string().trim().min(1).optional(),
  deviceLimit: z.coerce.number().int().positive().max(10).optional(),
  pauseExisting: z.boolean().optional()
});

adminRouter.post("/promo/start", async (req, res, next) => {
  try {
    const existing = await getActivePromo(prisma);
    if (existing) return res.status(409).json({ error: "A promo is already active or scheduled. End it before creating another." });
    const data = startPromoSchema.parse(req.body);
    const startsAt = data.startsAt ?? new Date();
    if (data.endsAt.getTime() <= Date.now()) return res.status(400).json({ error: "endsAt must be in the future." });
    if (data.endsAt.getTime() <= startsAt.getTime()) return res.status(400).json({ error: "endsAt must be after startsAt." });
    const promo = await startPromo(prisma, { ...data, startsAt });
    return sendData(res, promo);
  } catch (error) {
    return next(error);
  }
});

adminRouter.post("/promo/end", async (_req, res, next) => {
  try {
    const promo = await getActivePromo(prisma);
    if (!promo) return res.status(404).json({ error: "No active or scheduled promo." });
    const result = await endPromo(prisma, promo.id);
    return sendData(res, result);
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/credits", async (_req, res, next) => {
  try {
    const credits = await prisma.wifiCredit.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    return sendData(res, credits);
  } catch (error) {
    return next(error);
  }
});

const grantCreditSchema = z.object({
  customerPhone: z.string().min(7),
  durationSeconds: z.coerce.number().int().positive(),
  reason: z.enum(CREDIT_REASONS),
  deviceMac: optionalText.nullable().optional(),
  planId: optionalText,
  sourceReference: z.string().trim().min(1).optional(),
  expiresInHours: z.coerce.number().int().positive().max(24 * 31).optional(),
  expiresInDays: z.coerce.number().int().positive().optional(),
  note: z.string().trim().min(1).max(500).optional()
});

async function creditTemplatePlan(customerPhone: string, planId?: string) {
  if (planId) return prisma.wifiPlan.findUnique({ where: { id: planId } });

  const latestEntitlement = await prisma.wifiEntitlement.findFirst({
    where: { customerPhone },
    include: { plan: true },
    orderBy: { createdAt: "desc" }
  });
  if (latestEntitlement?.plan) return latestEntitlement.plan;

  const latestIntent = await prisma.wifiPaymentIntent.findFirst({
    where: { customerPhone },
    include: { plan: true },
    orderBy: { createdAt: "desc" }
  });
  if (latestIntent?.plan) return latestIntent.plan;

  return prisma.wifiPlan.findFirst({
    where: { enabled: true, priceKsh: { gt: 0 } },
    orderBy: [{ featured: "desc" }, { priceKsh: "asc" }, { durationSeconds: "asc" }, { name: "asc" }]
  });
}

adminRouter.post("/credits/grant", async (req, res, next) => {
  try {
    const data = grantCreditSchema.parse(req.body);
    const customerPhone = normalizeWifiUsername(data.customerPhone);
    const expiresAt = data.expiresInHours
      ? new Date(Date.now() + data.expiresInHours * 3600 * 1000)
      : data.expiresInDays
        ? new Date(Date.now() + data.expiresInDays * 86400 * 1000)
        : null;
    const plan = await creditTemplatePlan(customerPhone, data.planId);
    if (!plan) return res.status(400).json({ error: "No WiFi package exists to use as the credit template." });
    const credit = await grantWifiCredit(prisma, {
      customerPhone,
      deviceMac: normalizeDeviceMac(data.deviceMac),
      siteId: plan.siteId,
      planId: plan.id,
      durationSeconds: data.durationSeconds,
      rateLimit: plan.rateLimit,
      deviceLimit: plan.deviceLimit,
      reason: data.reason,
      sourceReference: data.sourceReference,
      expiresAt,
      createdBy: req.wifiAdminSession?.email ?? null,
      metadata: { ...(data.note ? { note: data.note } : {}), templatePlanName: plan.name }
    });
    return sendData(res, credit);
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/credits/balance/:phone", async (req, res, next) => {
  try {
    const customerPhone = normalizeWifiUsername(req.params.phone);
    const seconds = await availableCreditSeconds(prisma, customerPhone);
    return sendData(res, { customerPhone, availableSeconds: seconds });
  } catch (error) {
    return next(error);
  }
});
