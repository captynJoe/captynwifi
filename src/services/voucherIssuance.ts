import crypto from "node:crypto";
import type { Prisma, WifiPlan } from "@prisma/client";
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
}

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
  const expiresAt = new Date(startsAt.getTime() + plan.durationSeconds * 1000);
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
            confirmedAt: startsAt
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
            acctInterimSeconds: config.defaultAcctInterimSeconds
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
