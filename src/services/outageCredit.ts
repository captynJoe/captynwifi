import type { Prisma, PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { applyRadiusProjectionRows } from "./radiusSqlApply.js";
import { buildRadiusProjection } from "./radiusProjection.js";

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
  siteId: string;
  planId: string;
  expiresAt: Date;
  rateLimit: string | null;
  deviceLimit: number;
  outagePausedAt: Date | null;
  outagePauseCause: string | null;
};

export const ACCOUNTING_OUTAGE_SERVICE = "captyn-wifi-radius-accounting";
const LEGACY_OUTAGE_CREDIT_PREFIX = "outage-recovery-2026-11-03:";

export type AccountingOutageDecision =
  | { type: "advance"; checkpoint: Date }
  | { type: "healthy" }
  | { type: "credit"; creditedSeconds: number; outageStartedAt: Date };

export type ResumeDecision =
  | { type: "still-paused" }
  | { type: "resume"; creditedSeconds: number; reconnectedAt: Date };

function secondsBetween(start: Date, end: Date) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

export function expiryFromFrozenBalance(resumedAt: Date, remainingSeconds: number) {
  return new Date(resumedAt.getTime() + Math.max(0, remainingSeconds) * 1000);
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

  return { type: "credit", creditedSeconds: staleSeconds, outageStartedAt: checkpoint };
}

// Pure decision function for the per-entitlement resume sweep. `reconnectedAt`
// is that specific username's own next radacct session start after it was
// paused -- not any fleet-wide signal.
//
// A paused package keeps its remaining time only if the customer reconnects
// within the reconnect window: then the clock resumes exactly where it
// stopped (credit = the frozen gap). If the window closes first, the
// remaining time is forfeited (credit 0, so the already-past expiry ends it).
// It used to credit the whole window instead, quietly handing the
// remaining time back a day later to someone who never came back.
export function decideResumeAction(
  pausedAt: Date,
  reconnectedAt: Date | null,
  now: Date,
  reconnectWindowSeconds: number
): ResumeDecision {
  if (reconnectedAt) {
    const gap = secondsBetween(pausedAt, reconnectedAt);
    return { type: "resume", creditedSeconds: gap <= reconnectWindowSeconds ? gap : 0, reconnectedAt };
  }

  if (secondsBetween(pausedAt, now) > reconnectWindowSeconds) {
    return { type: "resume", creditedSeconds: 0, reconnectedAt: now };
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

function creditDurationLabel(totalSeconds: number) {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

async function creditEntitlement(
  tx: Prisma.TransactionClient,
  entitlement: EntitlementForCredit,
  remainingSeconds: number,
  recoveredAt: Date,
  now: Date
) {
  const pausedAt = entitlement.outagePausedAt ?? now;
  // Keep the paid entitlement and credentials in place. Restore the frozen
  // balance at the observed recovery timestamp so only the actual outage
  // interval extends access; worker polling delay must not add extra time.
  const currentPaidSibling = await tx.wifiEntitlement.findFirst({
    where: {
      username: entitlement.username,
      id: { not: entitlement.id },
      status: "active",
      expiresAt: { gt: now },
      outagePausedAt: null,
      promoPausedAt: null
    },
    orderBy: { expiresAt: "desc" }
  });
  const target = currentPaidSibling ?? entitlement;
  // For the paused entitlement itself, expiresAt already stores its original
  // paid endpoint. Reuse the frozen balance exactly once, starting at the
  // observed recovery time. Adding it to the old endpoint would double the
  // package on every outage cycle; starting at worker poll time would grant
  // extra time for polling delay. If an active sibling receives the balance,
  // append it there as before.
  const timeBase = target.id === entitlement.id
    ? recoveredAt
    : target.expiresAt > recoveredAt ? target.expiresAt : recoveredAt;
  const expiresAt = expiryFromFrozenBalance(timeBase, remainingSeconds);
  const resumed = await tx.wifiEntitlement.update({
    where: { id: target.id },
    data: { status: "active", expiresAt, outagePausedAt: null, outagePauseCause: null, outageRemainingSeconds: null }
  });
  if (target.id !== entitlement.id) {
    await tx.wifiEntitlement.update({
      where: { id: entitlement.id },
      data: { status: "expired", expiresAt: pausedAt, outagePausedAt: null, outagePauseCause: null, outageRemainingSeconds: null }
    });
  }
  const projection = buildRadiusProjection({
    entitlementId: resumed.id,
    phone: resumed.customerPhone,
    username: resumed.username,
    password: resumed.cleartextSecret,
    deviceMac: resumed.deviceMac,
    expiresAt,
    durationSeconds: Math.max(60, remainingSeconds),
    rateLimit: resumed.rateLimit,
    deviceLimit: resumed.deviceLimit
  });
  await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
  const existingProjection = await tx.wifiRadiusProjection.findUnique({ where: { entitlementId: resumed.id } });
  if (existingProjection) {
    await tx.wifiRadiusProjection.update({
      where: { id: existingProjection.id },
      data: {
        username: projection.username,
        checkItems: projection.checkItems,
        replyItems: projection.replyItems,
        status: "applied",
        appliedAt: now,
        lastError: null
      }
    });
  } else {
    await tx.wifiRadiusProjection.create({
      data: {
        entitlementId: resumed.id,
        username: projection.username,
        checkItems: projection.checkItems,
        replyItems: projection.replyItems,
        status: "applied",
        appliedAt: now
      }
    });
  }

  await tx.wifiNotification.create({
    data: {
      customerPhone: entitlement.customerPhone || entitlement.username,
      type: "outage_resolved",
      title: "Your WiFi time is restored",
      body: `Your connection is ready again. We restored the ${creditDurationLabel(remainingSeconds)} remaining on your package when the outage began.`,
      data: {
        entitlementId: entitlement.id,
        durationSeconds: remainingSeconds,
        reason: "OUTAGE_COMPENSATION",
        outageStartedAt: pausedAt.toISOString(),
        deviceMac: entitlement.deviceMac,
        planId: entitlement.planId
      }
    }
  });
}

// Marks every currently-active, not-already-paused entitlement as paused as
// of `outageStartedAt`. Entitlements already paused are left untouched so the
// original outage start time is preserved even if a detector re-fires while
// the same outage is still ongoing. Doesn't touch RADIUS state -- that only
// changes once the entitlement actually resumes (see resumePausedEntitlements).
async function pauseActiveEntitlements(tx: Prisma.TransactionClient, outageStartedAt: Date, cause: string): Promise<number> {
  const paused = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "WifiEntitlement"
    SET "outagePausedAt" = ${outageStartedAt},
        "outagePauseCause" = ${cause},
        "outageRemainingSeconds" = GREATEST(
          0,
          EXTRACT(EPOCH FROM ("expiresAt" - ${outageStartedAt}))::DOUBLE PRECISION
        ),
        "updatedAt" = now()
    WHERE status = 'active'
      AND "outagePausedAt" IS NULL
      AND "expiresAt" > ${outageStartedAt}
    RETURNING id
  `;
  return paused.length;
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

    // The worker being down doesn't take anyone offline -- RADIUS and the
    // router keep working; it only runs background jobs. A routine restart
    // (npm ci + build, ~3 min) used to freeze every package and hand out
    // free time. Only freeze if RADIUS accounting also went silent, i.e.
    // customers really were cut off (Lane B catches that case too).
    const lastActivity = await lastRadiusAccountingActivity(tx);
    if (lastActivity && lastActivity.getTime() > lastSeenAt.getTime() + config.outageCredit.graceSeconds * 1000) {
      await upsertHeartbeat(tx, service, now);
      return { paused: false, pausedCount: 0, outageSeconds };
    }

    const pausedCount = await pauseActiveEntitlements(tx, lastSeenAt, service);
    await upsertHeartbeat(tx, service, now);

    return { paused: pausedCount > 0, pausedCount, outageSeconds };
  }, { maxWait: 10_000, timeout: 30_000 });
}

export async function touchOutageHeartbeat(prisma: PrismaClient) {
  await prisma.$transaction((tx) => upsertHeartbeat(tx, config.outageCredit.serviceName, new Date()), {
    maxWait: 10_000,
    timeout: 30_000
  });
}

async function hasInterimDueActiveEntitlements(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM radacct r
      JOIN "WifiEntitlement" e ON e.username = r.username
      WHERE e.status = 'active' AND e."expiresAt" > now()
        AND r.acctstoptime IS NULL
        AND coalesce(r.acctupdatetime, r.acctstarttime)
          <= now() - (e."acctInterimSeconds" * interval '1 second')
    ) as "exists"
  `;
  return rows[0]?.exists ?? false;
}

async function lastRadiusAccountingActivity(tx: Prisma.TransactionClient): Promise<Date | null> {
  const rows = await tx.$queryRaw<{ last: Date | null }[]>`
    SELECT max(coalesce(r.acctupdatetime, r.acctstarttime)) as last
    FROM radacct r
    JOIN "WifiEntitlement" e ON e.username = r.username
    WHERE e.status = 'active' AND e."expiresAt" > now()
      AND r.acctstoptime IS NULL
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

    const lastActivity = await lastRadiusAccountingActivity(tx);
    if (!lastActivity) {
      return { paused: false, pausedCount: 0, outageSeconds: 0 };
    }

    const checkpointRows = await tx.$queryRaw<HeartbeatRow[]>`
      SELECT "lastSeenAt" FROM "WifiServiceHeartbeat" WHERE "service" = ${ACCOUNTING_OUTAGE_SERVICE} LIMIT 1
    `;
    const checkpoint = checkpointRows[0]?.lastSeenAt ?? lastActivity;
    if (!checkpointRows[0]) {
      await upsertHeartbeat(tx, ACCOUNTING_OUTAGE_SERVICE, checkpoint);
    }

    const decision = decideAccountingOutageAction(checkpoint, lastActivity, now, config.outageCredit.accountingGraceSeconds);

    // Advance on fresh activity first: a newly reconnected session is normally
    // too fresh for the interim-due predicate, but it is the evidence that
    // releases every entitlement paused during the outage.
    if (decision.type === "advance") {
      await upsertHeartbeat(tx, ACCOUNTING_OUTAGE_SERVICE, decision.checkpoint);
      return { paused: false, pausedCount: 0, outageSeconds: 0 };
    }

    if (decision.type === "healthy" || !(await hasInterimDueActiveEntitlements(tx))) {
      return { paused: false, pausedCount: 0, outageSeconds: secondsBetween(checkpoint, now) };
    }

    const pausedCount = await pauseActiveEntitlements(tx, decision.outageStartedAt, ACCOUNTING_OUTAGE_SERVICE);
    // Do not move the activity checkpoint on silence. resumePausedEntitlements
    // reads this same heartbeat as recovery evidence, so advancing it here
    // would let the detector certify its own false recovery one second later.
    // The checkpoint advances only in the `advance` branch above, on new
    // radacct activity.

    return { paused: pausedCount > 0, pausedCount, outageSeconds: decision.creditedSeconds };
  }, { maxWait: 10_000, timeout: 30_000 });
}

// Resume once fleet accounting proves the network has recovered. Each paused
// package is replaced with its unused balance at the original pause time, even
// if that customer's device has not produced a new RADIUS session yet. When a
// device session is present, use its MAC and timestamp for the audit end time.
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
        siteId: true,
        planId: true,
        expiresAt: true,
        rateLimit: true,
        deviceLimit: true,
        outagePausedAt: true,
        outagePauseCause: true,
        outageRemainingSeconds: true
      }
    });

    const recoveryRows = await tx.$queryRaw<HeartbeatRow[]>`
      SELECT "lastSeenAt" FROM "WifiServiceHeartbeat"
      WHERE "service" = ${ACCOUNTING_OUTAGE_SERVICE} LIMIT 1
    `;
    const fleetRecoveredAt = recoveryRows[0]?.lastSeenAt ?? null;

    let resumed = 0;
    let totalCreditedSeconds = 0;

    // Repair the one-time conversion deployed for the Nov 3 outage. Restore
    // unactivated wallet rows to their original paid entitlement; consumed
    // credits already created a working replacement entitlement and are left
    // alone. Expiring the wallet row makes this safe to rerun after restarts.
    const legacyCredits = await tx.wifiCredit.findMany({
      where: {
        sourceReference: { startsWith: LEGACY_OUTAGE_CREDIT_PREFIX },
        consumedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      take: config.outageCredit.batchSize,
      orderBy: { createdAt: "asc" }
    });
    for (const credit of legacyCredits) {
      const entitlementId = credit.sourceReference
        ?.slice(LEGACY_OUTAGE_CREDIT_PREFIX.length)
        .replace(/:remaining-at-outage$/, "");
      if (!entitlementId) continue;
      const entitlement = await tx.wifiEntitlement.findUnique({ where: { id: entitlementId } });
      if (!entitlement || entitlement.status !== "expired" || entitlement.outagePausedAt !== null) continue;
      const audit = await tx.wifiOutageCredit.findFirst({
        where: { entitlementId },
        orderBy: { createdAt: "desc" }
      });
      const remainingSeconds = audit?.remainingSeconds ?? audit?.creditedSeconds ?? 0;
      if (!audit || remainingSeconds <= 0) continue;

      await creditEntitlement(tx, {
        id: entitlement.id,
        customerPhone: entitlement.customerPhone,
        username: entitlement.username,
        cleartextSecret: entitlement.cleartextSecret,
        deviceMac: entitlement.deviceMac,
        siteId: entitlement.siteId,
        planId: entitlement.planId,
        expiresAt: entitlement.expiresAt,
        rateLimit: entitlement.rateLimit,
        deviceLimit: entitlement.deviceLimit,
        outagePausedAt: audit.outageStartedAt,
        outagePauseCause: audit.service
      }, remainingSeconds, audit.outageEndedAt, now);
      await tx.wifiCredit.update({ where: { id: credit.id }, data: { expiresAt: now } });
      resumed += 1;
      totalCreditedSeconds += secondsBetween(audit.outageStartedAt, audit.outageEndedAt);
    }

    for (const entitlement of paused) {
      const pausedAt = entitlement.outagePausedAt;
      if (!pausedAt) continue;

      const reconnectRows = await tx.$queryRaw<{ acctstarttime: Date }[]>`
        SELECT acctstarttime FROM radacct
        WHERE username = ${entitlement.username} AND acctstarttime > ${pausedAt}
          AND (
            ${entitlement.deviceMac}::text IS NULL
            OR regexp_replace(upper(coalesce(callingstationid, '')), '[^A-F0-9]', '', 'g')
              = regexp_replace(upper(${entitlement.deviceMac}::text), '[^A-F0-9]', '', 'g')
          )
        ORDER BY acctstarttime ASC
        LIMIT 1
      `;
      const deviceReconnectedAt = reconnectRows[0]?.acctstarttime ?? null;
      const reconnectedAt = deviceReconnectedAt ?? (fleetRecoveredAt && fleetRecoveredAt > pausedAt ? fleetRecoveredAt : null);
      if (!reconnectedAt) continue;

      const remainingSeconds = entitlement.outageRemainingSeconds ?? secondsBetween(pausedAt, entitlement.expiresAt);
      const outageSeconds = secondsBetween(pausedAt, reconnectedAt);
      const service = entitlement.outagePauseCause ?? "unknown";
      const inserted = await tx.$queryRaw<CreditInsertRow[]>`
        INSERT INTO "WifiOutageCredit" ("service", "outageStartedAt", "outageEndedAt", "creditedSeconds", "remainingSeconds", "affectedEntitlements", "entitlementId")
        VALUES (${service}, ${pausedAt}, ${reconnectedAt}, ${outageSeconds}, ${remainingSeconds}, 1, ${entitlement.id})
        ON CONFLICT ("service", "outageStartedAt", "outageEndedAt", "entitlementId") DO NOTHING
        RETURNING "id"
      `;
      if (inserted[0]?.id) {
        await creditEntitlement(tx, entitlement, remainingSeconds, reconnectedAt, now);
        totalCreditedSeconds += outageSeconds;
      }
      resumed += 1;
    }

    return { resumed, totalCreditedSeconds };
  }, { maxWait: 10_000, timeout: 30_000 });
}
