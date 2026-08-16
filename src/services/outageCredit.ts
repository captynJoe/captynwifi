import type { Prisma, PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { buildRadiusProjection } from "./radiusProjection.js";
import { applyRadiusProjectionRows } from "./radiusSqlApply.js";

type HeartbeatRow = { lastSeenAt: Date };

type CreditInsertRow = { id: string };

type PauseSummary = {
  paused: boolean;
  pausedCount: number;
  outageSeconds: number;
};

type ResumeSummary = {
  resumed: number;
  totalCreditedSeconds: number;
};

type EntitlementForCredit = {
  id: string;
  customerPhone: string;
  username: string;
  cleartextSecret: string;
  deviceMac: string | null;
  expiresAt: Date;
  rateLimit: string | null;
  deviceLimit: number;
};

export const ACCOUNTING_OUTAGE_SERVICE = "captyn-wifi-radius-accounting";

export type AccountingOutageDecision =
  | { type: "advance"; checkpoint: Date }
  | { type: "healthy" }
  | { type: "credit"; creditedSeconds: number; outageStartedAt: Date; nextCheckpoint: Date };

export type ResumeDecision =
  | { type: "still-paused" }
  | { type: "resume"; creditedSeconds: number; reconnectedAt: Date };

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

// Pure decision function for the per-entitlement resume sweep. `reconnectedAt`
// is that specific username's own next radacct session start after it was
// paused -- not any fleet-wide signal. A customer who never reconnects is
// force-released after maxCreditSeconds so they don't block expiry forever.
export function decideResumeAction(
  pausedAt: Date,
  reconnectedAt: Date | null,
  now: Date,
  maxCreditSeconds: number
): ResumeDecision {
  if (reconnectedAt) {
    return {
      type: "resume",
      creditedSeconds: Math.min(secondsBetween(pausedAt, reconnectedAt), maxCreditSeconds),
      reconnectedAt
    };
  }

  const elapsed = secondsBetween(pausedAt, now);
  if (elapsed > maxCreditSeconds) {
    return { type: "resume", creditedSeconds: maxCreditSeconds, reconnectedAt: now };
  }

  return { type: "still-paused" };
}

async function upsertHeartbeat(tx: Prisma.TransactionClient, service: string, now: Date) {
  await tx.$executeRaw`
    INSERT INTO "WifiServiceHeartbeat" ("service", "lastSeenAt", "updatedAt")
    VALUES (${service}, ${now}, ${now})
    ON CONFLICT ("service") DO UPDATE
      SET "lastSeenAt" = EXCLUDED."lastSeenAt", "updatedAt" = EXCLUDED."updatedAt"
  `;
}

async function creditEntitlement(
  tx: Prisma.TransactionClient,
  entitlement: EntitlementForCredit,
  creditedSeconds: number,
  now: Date
) {
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

// Marks every currently-active, not-already-paused entitlement as paused as
// of `outageStartedAt`. Entitlements already paused are left untouched so the
// original outage start time is preserved even if a detector re-fires while
// the same outage is still ongoing. Doesn't touch RADIUS state -- that only
// changes once the entitlement actually resumes (see resumePausedEntitlements).
async function pauseActiveEntitlements(tx: Prisma.TransactionClient, outageStartedAt: Date, cause: string): Promise<number> {
  const result = await tx.wifiEntitlement.updateMany({
    where: { status: "active", outagePausedAt: null, expiresAt: { gt: outageStartedAt } },
    data: { outagePausedAt: outageStartedAt, outagePauseCause: cause }
  });
  return result.count;
}

// Lane A: self-heartbeat, checked once at worker startup. A running loop's
// own heartbeat can't go stale while the loop is running, so this only ever
// catches the worker process itself having been down (crash/restart/VPS
// down) between the last time it ran and now.
export async function applyOutageCredit(prisma: PrismaClient): Promise<PauseSummary> {
  const now = new Date();
  const service = config.outageCredit.serviceName;

  if (!config.outageCredit.enabled) {
    await prisma.$transaction((tx) => upsertHeartbeat(tx, service, now));
    return { paused: false, pausedCount: 0, outageSeconds: 0 };
  }

  return prisma.$transaction(async (tx) => {
    const heartbeatRows = await tx.$queryRaw<HeartbeatRow[]>`
      SELECT "lastSeenAt" FROM "WifiServiceHeartbeat" WHERE "service" = ${service} LIMIT 1
    `;

    const lastSeenAt = heartbeatRows[0]?.lastSeenAt ?? null;
    if (!lastSeenAt) {
      await upsertHeartbeat(tx, service, now);
      return { paused: false, pausedCount: 0, outageSeconds: 0 };
    }

    const outageSeconds = secondsBetween(lastSeenAt, now);
    if (outageSeconds <= config.outageCredit.graceSeconds) {
      await upsertHeartbeat(tx, service, now);
      return { paused: false, pausedCount: 0, outageSeconds };
    }

    const pausedCount = await pauseActiveEntitlements(tx, lastSeenAt, service);
    await upsertHeartbeat(tx, service, now);

    return { paused: pausedCount > 0, pausedCount, outageSeconds };
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

// Lane B: fleet-wide RADIUS accounting silence, checked every tick. The
// self-heartbeat lane above can only ever catch the worker process itself
// crashing/restarting -- it can't see a live process whose actual path to
// customers is broken (e.g. the WireGuard tunnel to the MikroTik silently
// pointing at a dead port). This lane watches real RADIUS accounting
// activity instead, so it can flag an outage mid-incident rather than
// waiting for the next restart.
export async function evaluateAccountingOutage(prisma: PrismaClient): Promise<PauseSummary> {
  if (!config.outageCredit.enabled) {
    return { paused: false, pausedCount: 0, outageSeconds: 0 };
  }

  return prisma.$transaction(async (tx) => {
    const now = new Date();

    if (!(await hasInterimDueActiveEntitlements(tx))) {
      return { paused: false, pausedCount: 0, outageSeconds: 0 };
    }

    const lastActivity = await lastRadiusAccountingActivity(tx);
    if (!lastActivity) {
      return { paused: false, pausedCount: 0, outageSeconds: 0 };
    }

    const checkpointRows = await tx.$queryRaw<HeartbeatRow[]>`
      SELECT "lastSeenAt" FROM "WifiServiceHeartbeat" WHERE "service" = ${ACCOUNTING_OUTAGE_SERVICE} LIMIT 1
    `;
    const checkpoint = checkpointRows[0]?.lastSeenAt ?? lastActivity;

    const decision = decideAccountingOutageAction(checkpoint, lastActivity, now, config.outageCredit.accountingGraceSeconds);

    if (decision.type === "advance") {
      await upsertHeartbeat(tx, ACCOUNTING_OUTAGE_SERVICE, decision.checkpoint);
      return { paused: false, pausedCount: 0, outageSeconds: 0 };
    }

    if (decision.type === "healthy") {
      return { paused: false, pausedCount: 0, outageSeconds: secondsBetween(checkpoint, now) };
    }

    const pausedCount = await pauseActiveEntitlements(tx, decision.outageStartedAt, ACCOUNTING_OUTAGE_SERVICE);
    await upsertHeartbeat(tx, ACCOUNTING_OUTAGE_SERVICE, decision.nextCheckpoint);

    return { paused: pausedCount > 0, pausedCount, outageSeconds: decision.creditedSeconds };
  });
}

// Per-device resume sweep, independent of which lane triggered the pause and
// independent of whether the outage itself has "ended" fleet-wide -- a
// straggler whose device hasn't personally reconnected yet stays paused even
// after everyone else is back online.
export async function resumePausedEntitlements(prisma: PrismaClient): Promise<ResumeSummary> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();

    const paused = await tx.wifiEntitlement.findMany({
      where: { outagePausedAt: { not: null } },
      take: config.outageCredit.batchSize,
      select: {
        id: true,
        customerPhone: true,
        username: true,
        cleartextSecret: true,
        deviceMac: true,
        expiresAt: true,
        rateLimit: true,
        deviceLimit: true,
        outagePausedAt: true,
        outagePauseCause: true
      }
    });

    let resumed = 0;
    let totalCreditedSeconds = 0;

    for (const entitlement of paused) {
      const pausedAt = entitlement.outagePausedAt;
      if (!pausedAt) continue;

      const reconnectRows = await tx.$queryRaw<{ acctstarttime: Date }[]>`
        SELECT acctstarttime FROM radacct
        WHERE username = ${entitlement.username} AND acctstarttime > ${pausedAt}
        ORDER BY acctstarttime ASC
        LIMIT 1
      `;
      const reconnectedAt = reconnectRows[0]?.acctstarttime ?? null;

      const decision = decideResumeAction(pausedAt, reconnectedAt, now, config.outageCredit.maxCreditSeconds);
      if (decision.type === "still-paused") continue;

      if (decision.creditedSeconds > 0) {
        const inserted = await tx.$queryRaw<CreditInsertRow[]>`
          INSERT INTO "WifiOutageCredit" ("service", "outageStartedAt", "outageEndedAt", "creditedSeconds", "affectedEntitlements", "entitlementId")
          VALUES (${entitlement.outagePauseCause ?? "unknown"}, ${pausedAt}, ${decision.reconnectedAt}, ${decision.creditedSeconds}, 1, ${entitlement.id})
          ON CONFLICT ("service", "outageStartedAt", "outageEndedAt") DO NOTHING
          RETURNING "id"
        `;
        if (inserted[0]?.id) {
          await creditEntitlement(tx, entitlement, decision.creditedSeconds, now);
          totalCreditedSeconds += decision.creditedSeconds;
        }
      }

      await tx.wifiEntitlement.update({
        where: { id: entitlement.id },
        data: { outagePausedAt: null, outagePauseCause: null }
      });
      resumed += 1;
    }

    return { resumed, totalCreditedSeconds };
  });
}
