import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { getMpesaStatus } from "../services/mpesa.js";
import { issueVoucher } from "../services/voucherIssuance.js";
import { normalizeKenyaPhone } from "../lib/phone.js";

export const adminRouter = Router();

const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional()
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

const planCreateSchema = z.object({
  siteId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  externalPackageId: optionalText,
  durationSeconds: z.coerce.number().int().positive(),
  priceKsh: z.coerce.number().int().nonnegative(),
  rateLimit: optionalText,
  deviceLimit: z.coerce.number().int().positive().default(1),
  enabled: z.coerce.boolean().default(true),
  source: optionalText.default("captyn_admin")
});

const planUpdateSchema = planCreateSchema.partial().extend({ enabled: z.coerce.boolean().optional() });

const voucherCreateSchema = z.object({
  planId: z.string().trim().min(1),
  customerPhone: optionalText,
  deviceMac: optionalText.nullable().optional()
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
      appliedMissingRadiusRows
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
        from "WifiRadiusProjection" projection
        left join radcheck check_row on check_row.username = projection.username
        where projection.status = 'applied' and check_row.id is null
      `)
    ]);

    const radiusSqlHealthy = radcheck.ok && radreply.ok && appliedMissingRadiusRows.ok;
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
        !radiusSqlHealthy ? "bad" : appliedMissingRadiusRows.count > 0 ? "bad" : radcheck.count > 0 || activeEntitlementCount === 0 ? "ok" : "warn",
        !radiusSqlHealthy
          ? "RADIUS SQL tables could not be read."
          : appliedMissingRadiusRows.count > 0
            ? `${appliedMissingRadiusRows.count} applied projection${appliedMissingRadiusRows.count === 1 ? "" : "s"} missing radcheck rows.`
            : `${radcheck.count} check row${radcheck.count === 1 ? "" : "s"}, ${radreply.count} reply row${radreply.count === 1 ? "" : "s"}.`
      ),
      pipelineItem(
        "router_accounting",
        "MikroTik accounting",
        recentAccountingCount > 0 ? "ok" : activeEntitlementCount > 0 ? "warn" : "idle",
        recentAccountingCount > 0
          ? `${recentAccountingCount} recent accounting update${recentAccountingCount === 1 ? "" : "s"}.`
          : accountingSessionCount > 0
            ? `${accountingSessionCount} accounting session${accountingSessionCount === 1 ? "" : "s"}, none recent.`
            : "No router accounting received yet."
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
        appliedMissingRadiusRowsCount: appliedMissingRadiusRows.count,
        accountingSessionCount,
        recentAccountingCount
      },
      mpesa: { enabled: mpesa.enabled, configured: mpesa.configured, missing: mpesa.configured ? [] : mpesa.missing },
      radiusSql: { ok: radiusSqlHealthy, errors: [radcheck, radreply, appliedMissingRadiusRows].filter((item) => !item.ok).map((item) => item.error) },
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
      orderBy: [{ siteId: "asc" }, { durationSeconds: "asc" }],
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
        rateLimit: data.rateLimit,
        deviceLimit: data.deviceLimit,
        enabled: data.enabled
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
    const plan = await prisma.wifiPlan.update({
      where: { id: req.params.id },
      data: {
        ...(data.siteId !== undefined ? { siteId: data.siteId } : {}),
        ...(data.source !== undefined ? { source: data.source } : {}),
        ...(data.externalPackageId !== undefined ? { externalPackageId: data.externalPackageId } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}),
        ...(data.priceKsh !== undefined ? { priceKsh: data.priceKsh } : {}),
        ...(data.rateLimit !== undefined ? { rateLimit: data.rateLimit } : {}),
        ...(data.deviceLimit !== undefined ? { deviceLimit: data.deviceLimit } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {})
      },
      include: { site: true }
    });
    return sendData(res, plan);
  } catch (error) {
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

adminRouter.get("/accounting-sessions", async (_req, res, next) => {
  try {
    const data = await prisma.wifiAccountingSession.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100
    });
    return sendData(res, data);
  } catch (error) {
    return next(error);
  }
});
