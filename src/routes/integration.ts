import { Router } from "express";
import type { Prisma, WifiEntitlementStatus } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import {
  buildRadiusProjection,
  createRadiusSecret,
  normalizeDeviceMac,
  normalizeWifiUsername
} from "../services/radiusProjection.js";
import { issueVoucher } from "../services/voucherIssuance.js";
import { normalizeKenyaPhone } from "../lib/phone.js";
import { applyRadiusProjectionRows } from "../services/radiusSqlApply.js";

const MAX_BULK_VOUCHER_RECIPIENTS = 200;
const MAX_LIST_TAKE = 200;

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue) => (typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue))
  );
}
function sendData(res: import("express").Response, data: unknown) {
  return res.json({ data: toJsonSafe(data) });
}

const syncPackageSchema = z.object({
  site: z.object({
    id: z.string().min(1),
    name: z.string().min(1)
  }),
  package: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    hours: z.number().positive(),
    priceKsh: z.number().int().nonnegative(),
    rateLimit: z.string().trim().optional().nullable(),
    deviceLimit: z.number().int().positive().optional(),
    enabled: z.boolean().optional()
  })
});

const confirmPaymentSchema = z.object({
  sourceReference: z.string().min(1),
  providerReference: z.string().min(1).optional(),
  site: z.object({
    id: z.string().min(1),
    name: z.string().min(1)
  }),
  package: syncPackageSchema.shape.package,
  customerPhone: z.string().min(7),
  deviceMac: z.string().trim().optional().nullable(),
  amountKsh: z.number().int().nonnegative(),
  confirmedAt: z.string().datetime().optional(),
  rawPayload: z.unknown().optional()
});

export const integrationRouter = Router();

/**
 * Housing normally forwards its own building id, which upserts a distinct
 * "captyn_housing"-sourced site. When a building shares a physical router
 * with an existing site (e.g. an admin-created walk-in site), housing can
 * instead pass that site's real captyn-wifi UUID as `site.id` so purchases
 * land under the same site instead of creating a duplicate.
 */
async function resolveHousingSite(
  tx: Prisma.TransactionClient,
  site: { id: string; name: string }
) {
  const existingById = await tx.wifiSite.findUnique({ where: { id: site.id } });
  if (existingById) return existingById;

  return tx.wifiSite.upsert({
    where: { source_externalId: { source: "captyn_housing", externalId: site.id } },
    update: { name: site.name },
    create: {
      id: site.id,
      name: site.name,
      source: "captyn_housing",
      externalId: site.id
    }
  });
}

integrationRouter.post("/housing/packages/sync", async (req, res, next) => {
  try {
    const parsed = syncPackageSchema.parse(req.body);
    const site = await resolveHousingSite(prisma, parsed.site);

    const plan = await prisma.wifiPlan.upsert({
      where: {
        siteId_source_externalPackageId: {
          siteId: site.id,
          source: "captyn_housing",
          externalPackageId: parsed.package.id
        }
      },
      update: {
        name: parsed.package.name,
        durationSeconds: Math.round(parsed.package.hours * 60 * 60),
        priceKsh: parsed.package.priceKsh,
        rateLimit: parsed.package.rateLimit,
        deviceLimit: parsed.package.deviceLimit ?? 1,
        enabled: parsed.package.enabled ?? true
      },
      create: {
        siteId: site.id,
        source: "captyn_housing",
        externalPackageId: parsed.package.id,
        name: parsed.package.name,
        durationSeconds: Math.round(parsed.package.hours * 60 * 60),
        priceKsh: parsed.package.priceKsh,
        rateLimit: parsed.package.rateLimit,
        deviceLimit: parsed.package.deviceLimit ?? 1,
        enabled: parsed.package.enabled ?? true
      }
    });

    return res.json({ data: { site, plan } });
  } catch (error) {
    return next(error);
  }
});

integrationRouter.post("/housing/payments/confirmed", async (req, res, next) => {
  try {
    const parsed = confirmPaymentSchema.parse(req.body);
    const startsAt = parsed.confirmedAt ? new Date(parsed.confirmedAt) : new Date();
    const expiresAt = new Date(startsAt.getTime() + parsed.package.hours * 60 * 60 * 1000);

    const result = await prisma.$transaction(async (tx) => {
      const site = await resolveHousingSite(tx, parsed.site);

      const plan = await tx.wifiPlan.upsert({
        where: {
          siteId_source_externalPackageId: {
            siteId: site.id,
            source: "captyn_housing",
            externalPackageId: parsed.package.id
          }
        },
        update: {
          name: parsed.package.name,
          durationSeconds: Math.round(parsed.package.hours * 60 * 60),
          priceKsh: parsed.package.priceKsh,
          rateLimit: parsed.package.rateLimit,
          deviceLimit: parsed.package.deviceLimit ?? 1,
          enabled: parsed.package.enabled ?? true
        },
        create: {
          siteId: site.id,
          source: "captyn_housing",
          externalPackageId: parsed.package.id,
          name: parsed.package.name,
          durationSeconds: Math.round(parsed.package.hours * 60 * 60),
          priceKsh: parsed.package.priceKsh,
          rateLimit: parsed.package.rateLimit,
          deviceLimit: parsed.package.deviceLimit ?? 1,
          enabled: parsed.package.enabled ?? true
        }
      });

      const intent = await tx.wifiPaymentIntent.upsert({
        where: {
          source_sourceReference: {
            source: "captyn_housing",
            sourceReference: parsed.sourceReference
          }
        },
        update: {
          providerReference: parsed.providerReference,
          status: "confirmed",
          confirmedAt: startsAt,
          rawPayload: parsed.rawPayload === undefined ? undefined : (parsed.rawPayload as Prisma.InputJsonValue)
        },
        create: {
          siteId: site.id,
          planId: plan.id,
          source: "captyn_housing",
          sourceReference: parsed.sourceReference,
          customerPhone: parsed.customerPhone,
          deviceMac: normalizeDeviceMac(parsed.deviceMac),
          amountKsh: parsed.amountKsh,
          providerReference: parsed.providerReference,
          status: "confirmed",
          confirmedAt: startsAt,
          rawPayload: parsed.rawPayload === undefined ? undefined : (parsed.rawPayload as Prisma.InputJsonValue)
        }
      });

      const existing = await tx.wifiEntitlement.findUnique({
        where: { paymentIntentId: intent.id },
        include: { projection: true }
      });
      if (existing) return { intent, entitlement: existing, alreadyProcessed: true };

      const username = normalizeWifiUsername(parsed.customerPhone);
      const existingActive = await tx.wifiEntitlement.findFirst({
        where: { username, status: "active", expiresAt: { gt: startsAt } },
        include: { projection: true },
        orderBy: { expiresAt: "desc" }
      });

      if (existingActive) {
        const extendedExpiresAt = new Date(existingActive.expiresAt.getTime() + plan.durationSeconds * 1000);
        const extendedEntitlement = await tx.wifiEntitlement.update({
          where: { id: existingActive.id },
          data: { expiresAt: extendedExpiresAt }
        });

        const extendedProjection = buildRadiusProjection({
          entitlementId: extendedEntitlement.id,
          phone: parsed.customerPhone,
          username: extendedEntitlement.username,
          password: extendedEntitlement.cleartextSecret,
          deviceMac: extendedEntitlement.deviceMac,
          expiresAt: extendedExpiresAt,
          durationSeconds: Math.max(60, Math.round((extendedExpiresAt.getTime() - startsAt.getTime()) / 1000)),
          rateLimit: existingActive.rateLimit,
          deviceLimit: existingActive.deviceLimit
        });

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

        return {
          intent: await tx.wifiPaymentIntent.update({
            where: { id: intent.id },
            data: { status: "activated" }
          }),
          entitlement: extendedEntitlement,
          projection: radiusProjection,
          alreadyProcessed: false,
          extended: true
        };
      }

      const password = createRadiusSecret();

      const entitlement = await tx.wifiEntitlement.create({
        data: {
          siteId: site.id,
          planId: plan.id,
          paymentIntentId: intent.id,
          customerPhone: parsed.customerPhone,
          username,
          cleartextSecret: password,
          deviceMac: normalizeDeviceMac(parsed.deviceMac),
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
        phone: parsed.customerPhone,
        username,
        password,
        deviceMac: parsed.deviceMac,
        expiresAt,
        durationSeconds: plan.durationSeconds,
        rateLimit: plan.rateLimit,
        deviceLimit: plan.deviceLimit
      });

      // Apply synchronously instead of leaving it for the async worker (see
      // voucherIssuance.ts) — housing's resident portal attempts auto-connect
      // right after this call returns.
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

      return {
        intent: await tx.wifiPaymentIntent.update({
          where: { id: intent.id },
          data: { status: "activated" }
        }),
        entitlement,
        projection: radiusProjection,
        alreadyProcessed: false
      };
    });

    return res.status(result.alreadyProcessed ? 200 : 201).json({ data: result });
  } catch (error) {
    return next(error);
  }
});

const bulkVoucherSchema = z.object({
  planId: z.string().trim().min(1),
  phones: z.array(z.string().trim().min(1)).min(1).max(MAX_BULK_VOUCHER_RECIPIENTS),
  deviceMac: z.string().trim().optional().nullable()
});

const revokeSchema = z.object({
  status: z.enum(["revoked", "suspended"]).default("revoked")
});

/**
 * Admin-proxy surface for Housing's building-scoped Wi-Fi Department view.
 * Guarded by the same shared integration token as the rest of this router
 * (see server.ts mount) — no per-caller identity, matching the existing
 * housing<->wifi integration pattern.
 */

integrationRouter.get("/housing/sites/:siteId/plans", async (req, res, next) => {
  try {
    const siteId = req.params.siteId?.trim();
    if (!siteId) return res.status(400).json({ error: "siteId is required" });

    const data = await prisma.wifiPlan.findMany({
      where: { siteId, enabled: true },
      orderBy: { durationSeconds: "asc" }
    });
    return sendData(res, data);
  } catch (error) {
    return next(error);
  }
});

integrationRouter.get("/housing/sites/:siteId/entitlements", async (req, res, next) => {
  try {
    const siteId = req.params.siteId?.trim();
    if (!siteId) return res.status(400).json({ error: "siteId is required" });

    const phone = typeof req.query.phone === "string" ? normalizeKenyaPhone(req.query.phone) : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const take = Math.min(MAX_LIST_TAKE, Math.max(1, Number(req.query.take) || MAX_LIST_TAKE));

    const data = await prisma.wifiEntitlement.findMany({
      where: {
        siteId,
        ...(phone ? { customerPhone: phone } : {}),
        ...(status ? { status: status as WifiEntitlementStatus } : {})
      },
      orderBy: { createdAt: "desc" },
      take,
      include: { plan: true, projection: true }
    });
    return sendData(res, data);
  } catch (error) {
    return next(error);
  }
});

integrationRouter.get("/housing/sites/:siteId/sessions", async (req, res, next) => {
  try {
    const siteId = req.params.siteId?.trim();
    if (!siteId) return res.status(400).json({ error: "siteId is required" });

    const siteEntitlements = await prisma.wifiEntitlement.findMany({
      where: { siteId },
      select: { username: true }
    });
    const usernames = [...new Set(siteEntitlements.map((item) => item.username))];
    if (!usernames.length) return sendData(res, []);

    const data = await prisma.wifiAccountingSession.findMany({
      where: { username: { in: usernames } },
      orderBy: { updatedAt: "desc" },
      take: MAX_LIST_TAKE
    });
    return sendData(res, data);
  } catch (error) {
    return next(error);
  }
});

integrationRouter.post("/housing/sites/:siteId/vouchers/bulk", async (req, res, next) => {
  try {
    const siteId = req.params.siteId?.trim();
    if (!siteId) return res.status(400).json({ error: "siteId is required" });

    const data = bulkVoucherSchema.parse(req.body);
    const plan = await prisma.wifiPlan.findFirst({ where: { id: data.planId, siteId } });
    if (!plan) return res.status(404).json({ error: "Package not found for this site" });

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
        results.push({ phone, status: "failed", error: error instanceof Error ? error.message : "Voucher creation failed" });
      }
    }

    const created = results.filter((item) => item.status === "created").length;
    return res.status(201).json({
      data: { results, summary: { created, failed: results.length - created } }
    });
  } catch (error) {
    return next(error);
  }
});

integrationRouter.post("/housing/entitlements/:id/revoke", async (req, res, next) => {
  try {
    const id = req.params.id?.trim();
    if (!id) return res.status(400).json({ error: "entitlement id is required" });
    const data = revokeSchema.parse(req.body ?? {});

    const entitlement = await prisma.wifiEntitlement.findUnique({ where: { id }, include: { projection: true } });
    if (!entitlement) return res.status(404).json({ error: "Entitlement not found" });

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.wifiEntitlement.update({ where: { id }, data: { status: data.status } });
      if (entitlement.projection) {
        // Reset to "pending" so the RADIUS SQL worker's next tick sees this
        // entitlement is no longer active and deletes its radcheck/radreply
        // rows (see radiusSqlWorker.ts's applyProjection). This blocks future
        // re-authentication; it does not force-drop an already-connected
        // session (that needs MikroTik CoA, which this service doesn't do).
        await tx.wifiRadiusProjection.update({
          where: { id: entitlement.projection.id },
          data: { status: "pending", lastError: null }
        });
      }
      return result;
    });

    return sendData(res, updated);
  } catch (error) {
    return next(error);
  }
});
