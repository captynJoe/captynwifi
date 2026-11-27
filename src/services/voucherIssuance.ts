import crypto from "node:crypto";
import type { Prisma, PrismaClient, WifiPlan } from "@prisma/client";
import { prisma } from "../prisma.js";
import { config } from "../config.js";
import { buildRadiusProjection } from "./radiusProjection.js";
import { applyRadiusProjectionRows } from "./radiusSqlApply.js";

const VOUCHER_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L — avoids look-alike characters
const MAX_CODE_ATTEMPTS = 5;

function createVoucherCode(length = 8) {
  let code = "";
  for (let i = 0; i < length; i++) code += VOUCHER_ALPHABET[crypto.randomInt(VOUCHER_ALPHABET.length)];
  return code;
}

export interface IssueVoucherInput {
  customerPhone?: string;
  deviceMac?: string | null;
  // Who issued it (admin or integration), kept on the voucher's payment record.
  issuedBy?: { id: string; name: string | null };
  // Hours start when the voucher first connects (default), not at issue;
  // until then it's usable up to a use-by date. Housing's resident-portal
  // vouchers connect immediately, so they start at issue.
  startOnFirstUse?: boolean;
}

// How long an unused voucher stays usable before its hours start.
export const VOUCHER_USE_BY_MS = 7 * 24 * 3600 * 1000;

export interface IssuedVoucher {
  entitlement: Prisma.WifiEntitlementGetPayload<{ include: { site: true; plan: true } }>;
  code: string;
  expiresAt: Date;
}

/**
 * Creates one zero-cost voucher entitlement + pending RADIUS projection for
 * the given plan, inside a transaction. `WifiEntitlement.username` has no DB
 * uniqueness constraint, so this retries on the rare voucher-code collision.
 */
export async function issueVoucher(plan: WifiPlan, input: IssueVoucherInput): Promise<IssuedVoucher> {
  const startsAt = new Date();
  const startOnFirstUse = input.startOnFirstUse ?? true;
  const expiresAt = new Date(startsAt.getTime() + (startOnFirstUse ? VOUCHER_USE_BY_MS : plan.durationSeconds * 1000));
  const customerPhone = input.customerPhone ?? "";
  const deviceMac = input.deviceMac ?? null;

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = createVoucherCode();

    try {
      const entitlement = await prisma.$transaction(async (tx) => {
        const collision = await tx.wifiEntitlement.findFirst({ where: { username: code } });
        if (collision) {
          throw new VoucherCodeCollisionError();
        }

        const intent = await tx.wifiPaymentIntent.create({
          data: {
            siteId: plan.siteId,
            planId: plan.id,
            source: "captyn_admin_voucher",
            sourceReference: `voucher-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
            customerPhone,
            deviceMac,
            amountKsh: 0,
            provider: "voucher",
            status: "activated",
            confirmedAt: startsAt,
            rawPayload: input.issuedBy ? { issuedBy: input.issuedBy } : undefined
          }
        });

        const created = await tx.wifiEntitlement.create({
          data: {
            siteId: plan.siteId,
            planId: plan.id,
            paymentIntentId: intent.id,
            customerPhone,
            username: code,
            cleartextSecret: code,
            deviceMac,
            status: "active",
            startsAt,
            expiresAt,
            deviceLimit: plan.deviceLimit,
            rateLimit: plan.rateLimit,
            acctInterimSeconds: config.defaultAcctInterimSeconds,
            startsOnFirstUseSeconds: startOnFirstUse ? plan.durationSeconds : null
          },
          include: { site: true, plan: true }
        });

        const projection = buildRadiusProjection({
          entitlementId: created.id,
          phone: customerPhone,
          username: code,
          password: code,
          deviceMac,
          expiresAt,
          durationSeconds: plan.durationSeconds,
          rateLimit: plan.rateLimit,
          deviceLimit: plan.deviceLimit
        });

        // Apply radcheck/radreply synchronously instead of leaving the
        // projection "pending" for the async worker to pick up (worst case
        // CAPTYN_WIFI_RADIUS_SQL_POLL_INTERVAL_MS later) — a voucher is
        // handed straight to a customer who may try it within seconds, so it
        // needs to be redeemable the instant it's created.
        await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
        await tx.wifiRadiusProjection.create({
          data: {
            entitlementId: created.id,
            username: projection.username,
            checkItems: projection.checkItems,
            replyItems: projection.replyItems,
            status: "applied",
            appliedAt: startsAt
          }
        });

        return created;
      });

      return { entitlement, code, expiresAt: entitlement.expiresAt };
    } catch (error) {
      if (error instanceof VoucherCodeCollisionError) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Could not generate a unique voucher code");
}

class VoucherCodeCollisionError extends Error {
  constructor() {
    super("Voucher code collision");
  }
}

// A start-on-first-use voucher just connected (or is about to): its hours
// start now. expiresAt becomes start + hours, the RADIUS login gets the real
// end time, and the field is cleared so this happens once. Safe to call twice.
export async function startPendingVoucher(prisma: PrismaClient, entitlementId: string, startedAt = new Date()) {
  return prisma.$transaction(async (tx) => {
    const pending = await tx.wifiEntitlement.findFirst({ where: { id: entitlementId, startsOnFirstUseSeconds: { not: null }, status: "active" } });
    if (!pending?.startsOnFirstUseSeconds) return null;
    const expiresAt = new Date(startedAt.getTime() + pending.startsOnFirstUseSeconds * 1000);
    const started = await tx.wifiEntitlement.update({
      where: { id: pending.id },
      data: { startsAt: startedAt, expiresAt, startsOnFirstUseSeconds: null }
    });
    const projection = buildRadiusProjection({
      entitlementId: started.id,
      phone: started.customerPhone,
      username: started.username,
      password: started.cleartextSecret,
      deviceMac: started.deviceMac,
      expiresAt,
      durationSeconds: pending.startsOnFirstUseSeconds,
      rateLimit: started.rateLimit,
      deviceLimit: started.deviceLimit
    });
    await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
    await tx.wifiRadiusProjection.updateMany({
      where: { entitlementId: started.id },
      data: { checkItems: projection.checkItems, replyItems: projection.replyItems, status: "applied", appliedAt: startedAt }
    });
    return started;
  });
}

// Vouchers that connected through the router's own login page: their first
// accounting record is the first use. Run by the RADIUS worker.
export async function startVouchersOnFirstUse(prisma: PrismaClient) {
  const pending = await prisma.wifiEntitlement.findMany({
    where: { startsOnFirstUseSeconds: { not: null }, status: "active" },
    select: { id: true, username: true },
    take: 200
  });
  if (pending.length === 0) return 0;
  const firstUse = await prisma.$queryRaw<Array<{ username: string; first: Date }>>`
    SELECT username, min(acctstarttime) AS first FROM radacct
    WHERE username = ANY(${pending.map((p) => p.username)}) GROUP BY username`;
  const firstByUser = new Map(firstUse.map((row) => [row.username, row.first]));
  let started = 0;
  for (const voucher of pending) {
    const first = firstByUser.get(voucher.username);
    if (!first) continue;
    if (await startPendingVoucher(prisma, voucher.id, first)) started += 1;
  }
  return started;
}
