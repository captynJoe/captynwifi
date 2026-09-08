import type { Prisma, PrismaClient } from "@prisma/client";

// Plain strings, not a Prisma enum, so a new reason never needs a migration
// -- these are just the ones today's compensation logic actually uses.
export const CREDIT_REASONS = [
  "OUTAGE_COMPENSATION",
  "PROMO_COMPENSATION",
  "MANUAL_ADJUSTMENT",
  "SERVICE_RECOVERY"
] as const;

export type GrantCreditInput = {
  customerPhone: string;
  deviceMac?: string | null;
  siteId?: string | null;
  planId?: string | null;
  durationSeconds: number;
  rateLimit?: string | null;
  deviceLimit?: number | null;
  reason: string;
  sourceReference?: string | null;
  expiresAt?: Date | null;
  createdBy?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export function formatCreditDuration(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function creditNotificationBody(durationSeconds: number, reason: string, expiresAt?: Date | null): string {
  const readable = formatCreditDuration(durationSeconds);
  const cause =
    reason === "OUTAGE_COMPENSATION" || reason === "PROMO_COMPENSATION" || reason === "SERVICE_RECOVERY"
      ? "a service interruption"
      : "an account adjustment";
  const expiryHint = expiresAt ? " before it expires" : "";
  return `You received ${readable} of free WiFi time because of ${cause}. Tap Activate${expiryHint}; the timer starts when you activate.`;
}

// Inserts the credit ledger row and its notification atomically -- actual
// delivery (push/SMS/etc) is a separate, later concern layered on top of
// the notification record, not something this function does itself. This
// only guarantees the ledger entry and the in-portal fallback both exist
// the moment credit is granted.
export async function grantWifiCredit(prisma: PrismaClient, input: GrantCreditInput) {
  return prisma.$transaction(async (tx) => {
    const credit = await tx.wifiCredit.create({
      data: {
        customerPhone: input.customerPhone,
        deviceMac: input.deviceMac ?? null,
        siteId: input.siteId ?? null,
        planId: input.planId ?? null,
        durationSeconds: input.durationSeconds,
        rateLimit: input.rateLimit ?? null,
        deviceLimit: input.deviceLimit ?? null,
        reason: input.reason,
        sourceReference: input.sourceReference ?? null,
        expiresAt: input.expiresAt ?? null,
        createdBy: input.createdBy ?? null,
        metadata: input.metadata
      }
    });

    await tx.wifiNotification.create({
      data: {
        customerPhone: input.customerPhone,
        type: "credit_granted",
        title: "We've credited your account",
        body: creditNotificationBody(input.durationSeconds, input.reason, input.expiresAt),
        data: {
          creditId: credit.id,
          durationSeconds: input.durationSeconds,
          reason: input.reason,
          expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
          deviceMac: input.deviceMac ?? null,
          planId: input.planId ?? null
        }
      }
    });

    return credit;
  });
}

// Sum of unconsumed, unexpired credit (in seconds) for a phone -- what the
// admin dashboard and support tooling show as someone's balance. Customer-
// facing credits are activated explicitly from the portal, not silently
// folded into a later paid checkout.
export async function availableCreditSeconds(
  db: PrismaClient | Prisma.TransactionClient,
  customerPhone: string,
  at = new Date()
): Promise<number> {
  const result = await db.wifiCredit.aggregate({
    where: { customerPhone, consumedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
    _sum: { durationSeconds: true }
  });
  return result._sum.durationSeconds ?? 0;
}

// Maintenance helper for one-off account adjustments that need to consume
// every available credit at once. The public portal activation path consumes
// a single chosen credit row so customers stay in control of when free time
// starts ticking.
export async function consumeAvailableCredit(
  tx: Prisma.TransactionClient,
  customerPhone: string,
  entitlementId: string,
  at = new Date()
): Promise<number> {
  const credits = await tx.wifiCredit.findMany({
    where: { customerPhone, consumedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
    orderBy: { createdAt: "asc" }
  });

  let totalSeconds = 0;
  for (const credit of credits) {
    await tx.wifiCredit.update({
      where: { id: credit.id },
      data: { consumedAt: at, consumedEntitlementId: entitlementId }
    });
    totalSeconds += credit.durationSeconds;
  }
  return totalSeconds;
}
