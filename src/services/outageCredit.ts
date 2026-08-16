import type { Prisma, PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { buildRadiusProjection } from "./radiusProjection.js";
import { applyRadiusProjectionRows } from "./radiusSqlApply.js";

type HeartbeatRow = { lastSeenAt: Date };

type CreditInsertRow = { id: string };

type CreditSummary = {
  credited: boolean;
  outageSeconds: number;
  creditedSeconds: number;
  affectedEntitlements: number;
};

export const ACCOUNTING_OUTAGE_SERVICE = "captyn-wifi-radius-accounting";

export type AccountingOutageDecision =
  | { type: "advance"; checkpoint: Date }
  | { type: "healthy" }
  | { type: "credit"; creditedSeconds: number; outageStartedAt: Date; nextCheckpoint: Date };

function secondsBetween(start: Date, end: Date) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

// Pure decision function for the accounting-activity outage lane. Unlike the
// self-heartbeat lane (touched every tick just for being called), this
// checkpoint only moves forward on real evidence: fresh radacct activity
// somewhere in the fleet. If it hasn't moved and is older than the grace
// window, the network path to customers has been silent that whole time.
export function decideAccountingOutageAction(
  checkpoint: Date,
  lastActivity: Date,
  now: Date,
  graceSeconds: number
): AccountingOutageDecision {
  if (lastActivity.getTime() > checkpoint.getTime()) {
    return { type: "advance", checkpoint: lastActivity };
  }

  const staleSeconds = secondsBetween(checkpoint, now);
  if (staleSeconds <= graceSeconds) {
    return { type: "healthy" };
  }

  return { type: "credit", creditedSeconds: staleSeconds, outageStartedAt: checkpoint, nextCheckpoint: now };
}

async function upsertHeartbeat(tx: Prisma.TransactionClient, service: string, now: Date) {
  await tx.$executeRaw`
    INSERT INTO "WifiServiceHeartbeat" ("service", "lastSeenAt", "updatedAt")
    VALUES (${service}, ${now}, ${now})
    ON CONFLICT ("service") DO UPDATE
      SET "lastSeenAt" = EXCLUDED."lastSeenAt", "updatedAt" = EXCLUDED."updatedAt"
  `;
}

async function creditEntitlement(tx: Prisma.TransactionClient, entitlement: {
  id: string;
  customerPhone: string;
  username: string;
  cleartextSecret: string;
  deviceMac: string | null;
  expiresAt: Date;
  rateLimit: string | null;
  deviceLimit: number;
}, creditedSeconds: number, now: Date) {
  const expiresAt = new Date(entitlement.expiresAt.getTime() + creditedSeconds * 1000);
  const durationSeconds = Math.max(60, secondsBetween(now, expiresAt));

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

  await tx.wifiEntitlement.update({
    where: { id: entitlement.id },
    data: { expiresAt }
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
      appliedAt: now,
      lastError: null
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

export async function applyOutageCredit(prisma: PrismaClient): Promise<CreditSummary> {
  const now = new Date();
  const service = config.outageCredit.serviceName;

  if (!config.outageCredit.enabled) {
    await prisma.$transaction((tx) => upsertHeartbeat(tx, service, now));
    return { credited: false, outageSeconds: 0, creditedSeconds: 0, affectedEntitlements: 0 };
  }

  return prisma.$transaction(async (tx) => {
    const heartbeatRows = await tx.$queryRaw<HeartbeatRow[]>`
      SELECT "lastSeenAt" FROM "WifiServiceHeartbeat" WHERE "service" = ${service} LIMIT 1
    `;

    const lastSeenAt = heartbeatRows[0]?.lastSeenAt ?? null;
    if (!lastSeenAt) {
      await upsertHeartbeat(tx, service, now);
      return { credited: false, outageSeconds: 0, creditedSeconds: 0, affectedEntitlements: 0 };
    }

    const outageSeconds = secondsBetween(lastSeenAt, now);
    if (outageSeconds <= config.outageCredit.graceSeconds) {
      await upsertHeartbeat(tx, service, now);
      return { credited: false, outageSeconds, creditedSeconds: 0, affectedEntitlements: 0 };
    }

    const creditedSeconds = Math.min(outageSeconds, config.outageCredit.maxCreditSeconds);
    const outageEndedAt = new Date(lastSeenAt.getTime() + creditedSeconds * 1000);
    const inserted = await tx.$queryRaw<CreditInsertRow[]>`
      INSERT INTO "WifiOutageCredit" ("service", "outageStartedAt", "outageEndedAt", "creditedSeconds", "affectedEntitlements")
      VALUES (${service}, ${lastSeenAt}, ${outageEndedAt}, ${creditedSeconds}, 0)
      ON CONFLICT ("service", "outageStartedAt", "outageEndedAt") DO NOTHING
      RETURNING "id"
    `;

    if (!inserted[0]?.id) {
      await upsertHeartbeat(tx, service, now);
      return { credited: false, outageSeconds, creditedSeconds: 0, affectedEntitlements: 0 };
    }

    const entitlements = await tx.wifiEntitlement.findMany({
      where: {
        status: "active",
        expiresAt: { gt: lastSeenAt },
        startsAt: { lt: now }
      },
      orderBy: { expiresAt: "asc" },
      take: config.outageCredit.batchSize,
      select: {
        id: true,
        customerPhone: true,
        username: true,
        cleartextSecret: true,
        deviceMac: true,
        expiresAt: true,
        rateLimit: true,
        deviceLimit: true
      }
    });

    let affectedEntitlements = 0;
    for (const entitlement of entitlements) {
      await creditEntitlement(tx, entitlement, creditedSeconds, now);
      affectedEntitlements += 1;
    }

    await tx.$executeRaw`
      UPDATE "WifiOutageCredit"
      SET "affectedEntitlements" = ${affectedEntitlements}
      WHERE "id" = ${inserted[0].id}
    `;
    await upsertHeartbeat(tx, service, now);

    return { credited: true, outageSeconds, creditedSeconds, affectedEntitlements };
  });
}

export async function touchOutageHeartbeat(prisma: PrismaClient) {
  await prisma.$transaction((tx) => upsertHeartbeat(tx, config.outageCredit.serviceName, new Date()));
}

async function hasInterimDueActiveEntitlements(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "WifiEntitlement"
      WHERE status = 'active' AND "expiresAt" > now()
        AND "startsAt" <= now() - ("acctInterimSeconds" * interval '1 second')
    ) as "exists"
  `;
  return rows[0]?.exists ?? false;
}

async function lastRadiusAccountingActivity(tx: Prisma.TransactionClient): Promise<Date | null> {
  const rows = await tx.$queryRaw<{ last: Date | null }[]>`
    SELECT max(coalesce(acctupdatetime, acctstarttime)) as last FROM radacct
  `;
  return rows[0]?.last ?? null;
}

// Second, independent outage-detection lane. The self-heartbeat lane above
// can only ever catch the worker process itself crashing/restarting -- it
// can't see a live process whose actual path to customers is broken (e.g.
// the WireGuard tunnel to the MikroTik silently pointing at a dead port).
// This lane watches real RADIUS accounting activity instead, so it can
// credit mid-outage rather than waiting for the next restart.
export async function evaluateAccountingOutage(prisma: PrismaClient): Promise<CreditSummary> {
  if (!config.outageCredit.enabled) {
    return { credited: false, outageSeconds: 0, creditedSeconds: 0, affectedEntitlements: 0 };
  }

  return prisma.$transaction(async (tx) => {
    const now = new Date();

    if (!(await hasInterimDueActiveEntitlements(tx))) {
      return { credited: false, outageSeconds: 0, creditedSeconds: 0, affectedEntitlements: 0 };
    }

    const lastActivity = await lastRadiusAccountingActivity(tx);
    if (!lastActivity) {
      return { credited: false, outageSeconds: 0, creditedSeconds: 0, affectedEntitlements: 0 };
    }

    const checkpointRows = await tx.$queryRaw<HeartbeatRow[]>`
      SELECT "lastSeenAt" FROM "WifiServiceHeartbeat" WHERE "service" = ${ACCOUNTING_OUTAGE_SERVICE} LIMIT 1
    `;
    const checkpoint = checkpointRows[0]?.lastSeenAt ?? lastActivity;

    const decision = decideAccountingOutageAction(checkpoint, lastActivity, now, config.outageCredit.accountingGraceSeconds);

    if (decision.type === "advance") {
      await upsertHeartbeat(tx, ACCOUNTING_OUTAGE_SERVICE, decision.checkpoint);
      return { credited: false, outageSeconds: 0, creditedSeconds: 0, affectedEntitlements: 0 };
    }

    if (decision.type === "healthy") {
      return { credited: false, outageSeconds: secondsBetween(checkpoint, now), creditedSeconds: 0, affectedEntitlements: 0 };
    }

    const outageEndedAt = decision.nextCheckpoint;
    const inserted = await tx.$queryRaw<CreditInsertRow[]>`
      INSERT INTO "WifiOutageCredit" ("service", "outageStartedAt", "outageEndedAt", "creditedSeconds", "affectedEntitlements")
      VALUES (${ACCOUNTING_OUTAGE_SERVICE}, ${decision.outageStartedAt}, ${outageEndedAt}, ${decision.creditedSeconds}, 0)
      ON CONFLICT ("service", "outageStartedAt", "outageEndedAt") DO NOTHING
      RETURNING "id"
    `;

    if (!inserted[0]?.id) {
      // Already recorded this exact window (e.g. a concurrent tick beat us to
      // it) -- still advance the checkpoint so we don't re-evaluate the same
      // stale window forever.
      await upsertHeartbeat(tx, ACCOUNTING_OUTAGE_SERVICE, outageEndedAt);
      return { credited: false, outageSeconds: decision.creditedSeconds, creditedSeconds: 0, affectedEntitlements: 0 };
    }

    const entitlements = await tx.wifiEntitlement.findMany({
      where: {
        status: "active",
        expiresAt: { gt: decision.outageStartedAt },
        startsAt: { lt: now }
      },
      orderBy: { expiresAt: "asc" },
      take: config.outageCredit.batchSize,
      select: {
        id: true,
        customerPhone: true,
        username: true,
        cleartextSecret: true,
        deviceMac: true,
        expiresAt: true,
        rateLimit: true,
        deviceLimit: true
      }
    });

    let affectedEntitlements = 0;
    for (const entitlement of entitlements) {
      await creditEntitlement(tx, entitlement, decision.creditedSeconds, now);
      affectedEntitlements += 1;
    }

    await tx.$executeRaw`
      UPDATE "WifiOutageCredit"
      SET "affectedEntitlements" = ${affectedEntitlements}
      WHERE "id" = ${inserted[0].id}
    `;
    await upsertHeartbeat(tx, ACCOUNTING_OUTAGE_SERVICE, outageEndedAt);

    return { credited: true, outageSeconds: decision.creditedSeconds, creditedSeconds: decision.creditedSeconds, affectedEntitlements };
  });
}
