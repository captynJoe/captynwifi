import "dotenv/config";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { applyRadiusProjectionRows, hasOtherActiveEntitlement } from "../services/radiusSqlApply.js";
import { applyOutageCredit, evaluateAccountingOutage, resumePausedEntitlements, touchOutageHeartbeat } from "../services/outageCredit.js";
import { activateDuePromos, endPromo, getActivePromo } from "../services/promo.js";
import { kickHotspotUser } from "../services/routeros.js";

async function applyProjection(id: string) {
  await prisma.$transaction(async (tx) => {
    const projection = await tx.wifiRadiusProjection.findUnique({
      where: { id },
      include: { entitlement: true }
    });
    if (!projection) return;

    const now = new Date();
    const isActive = projection.entitlement.status === "active" && projection.entitlement.expiresAt > now;
    if (!isActive) {
      const keepRows = await hasOtherActiveEntitlement(tx, projection.username, projection.entitlement.id, now);
      if (!keepRows) {
        await tx.$executeRaw`DELETE FROM radcheck WHERE username = ${projection.username}`;
        await tx.$executeRaw`DELETE FROM radreply WHERE username = ${projection.username}`;
      }
      await tx.wifiRadiusProjection.update({
        where: { id: projection.id },
        data: { status: "applied", lastError: null, appliedAt: now }
      });
      return;
    }

    await applyRadiusProjectionRows(tx, projection.username, projection.checkItems, projection.replyItems);
    await tx.wifiRadiusProjection.update({
      where: { id: projection.id },
      data: { status: "applied", lastError: null, appliedAt: now }
    });
  });
}

async function expireEntitlements() {
  const now = new Date();
  const expired = await prisma.wifiEntitlement.findMany({
    // Paused entitlements (outage OR promo) are excluded -- they keep their
    // RADIUS credentials until the relevant resume sweep processes them,
    // even if their frozen expiresAt has already passed real time while
    // paused. See resumePausedEntitlements / endPromo for the resume paths.
    where: { status: "active", expiresAt: { lte: now }, outagePausedAt: null, promoPausedAt: null },
    select: { id: true, username: true, projection: { select: { id: true, status: true } } },
    take: config.radiusSql.batchSize
  });

  for (const entitlement of expired) {
    await prisma.$transaction(async (tx) => {
      await tx.wifiEntitlement.update({ where: { id: entitlement.id }, data: { status: "expired" } });
      const keepRows = await hasOtherActiveEntitlement(tx, entitlement.username, entitlement.id, now);
      if (!keepRows) {
        await tx.$executeRaw`DELETE FROM radcheck WHERE username = ${entitlement.username}`;
        await tx.$executeRaw`DELETE FROM radreply WHERE username = ${entitlement.username}`;
      }
      // Only stamp status/appliedAt if the projection was never actually applied
      // (still pending/failed at expiry). Otherwise this would overwrite the
      // real apply time with the expiry time, making it look like every grant
      // was delayed until expiry even when it was applied promptly.
      if (entitlement.projection && entitlement.projection.status !== "applied") {
        await tx.wifiRadiusProjection.update({
          where: { id: entitlement.projection.id },
          data: { status: "applied", lastError: null, appliedAt: now }
        });
      }
    });
  }
}

// M-PESA callbacks aren't guaranteed delivery -- if Safaricom's callback never
// arrives (dropped, customer's phone unreachable, etc.) a payment intent
// would otherwise sit in pending_confirmation forever with no entitlement
// ever created. updatedAt is what moves this window: the STK-initiate step
// touches it once right after creation, so this only counts idle time since
// then, not time since the customer first tapped Pay.
async function expireStalePaymentIntents() {
  const cutoff = new Date(Date.now() - config.mpesa.pendingTimeoutSeconds * 1000);
  const result = await prisma.wifiPaymentIntent.updateMany({
    where: { status: "pending_confirmation", updatedAt: { lt: cutoff } },
    data: { status: "failed" }
  });
  return result.count;
}

async function applyPendingBatch() {
  const projections = await prisma.wifiRadiusProjection.findMany({
    where: { status: "pending" },
    orderBy: { updatedAt: "asc" },
    select: { id: true },
    take: config.radiusSql.batchSize
  });

  for (const projection of projections) {
    try {
      await applyProjection(projection.id);
    } catch (error) {
      await prisma.wifiRadiusProjection.update({
        where: { id: projection.id },
        data: {
          status: "failed",
          lastError: error instanceof Error ? error.message.slice(0, 1000) : "Unknown RADIUS projection failure"
        }
      });
    }
  }

  return projections.length;
}

async function activateScheduledPromo() {
  const result = await activateDuePromos(prisma);
  if (result.activated > 0) console.log(`Promo started: paused ${result.paused} active entitlement(s)`);
}

async function endExpiredPromo() {
  const promo = await getActivePromo(prisma);
  if (!promo || Date.now() < promo.endsAt.getTime()) return;
  const result = await endPromo(prisma, promo.id);
  console.log(`Promo ended: resumed ${result.resumed} paused entitlement(s)`);
}

// Expiring an entitlement deletes its radcheck rows, which only blocks new
// logins -- a device already online kept browsing until its Session-Timeout,
// which is the *full* plan duration from whenever that session started
// (measured: 12% of paid sessions ran past expiry, up to ~10h). Disconnect
// any open session whose username no longer has RADIUS credentials. Retried
// at most once a minute per user, so a failed kick is retried without
// hammering the router.
const lastKickAttempt = new Map<string, number>();
const KICK_RETRY_MS = 60_000;

async function kickSessionsWithoutCredentials() {
  const rows = await prisma.$queryRaw<{ username: string }[]>`
    SELECT DISTINCT r.username
    FROM radacct r
    WHERE r.acctstoptime IS NULL
      AND r.username IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM radcheck c WHERE c.username = r.username)
  `;
  const now = Date.now();
  const open = new Set(rows.map((row) => row.username));
  for (const username of lastKickAttempt.keys()) {
    if (!open.has(username)) lastKickAttempt.delete(username);
  }

  let kicked = 0;
  for (const { username } of rows) {
    if (now - (lastKickAttempt.get(username) ?? 0) < KICK_RETRY_MS) continue;
    lastKickAttempt.set(username, now);
    const result = await kickHotspotUser(username);
    if (result.skippedReason) return kicked; // RouterOS API not configured -- nothing to retry
    if (result.error) console.warn(`Expired-session kick ${username} failed: ${result.error}`);
    kicked += result.removed;
  }
  return kicked;
}

// Simultaneous-Use counts radacct rows with no stop time, so a session the
// router never closed (power cut, no Accounting-Stop) would hold a device
// slot for good. Close sessions that have missed several interim updates --
// only while other sessions are still reporting, so a network outage that
// silences everything doesn't mass-close live sessions.
async function closeStaleSessions() {
  return prisma.$executeRaw`
    UPDATE radacct
    SET acctstoptime = coalesce(acctupdatetime, acctstarttime), acctterminatecause = 'Stale-Session'
    WHERE acctstoptime IS NULL
      AND coalesce(acctupdatetime, acctstarttime) < now() - interval '10 minutes'
      AND EXISTS (SELECT 1 FROM radacct WHERE coalesce(acctupdatetime, acctstarttime) > now() - interval '5 minutes')
  `;
}

async function tick() {
  await expireEntitlements();
  const timedOutPayments = await expireStalePaymentIntents();
  if (timedOutPayments > 0) console.log(`Marked ${timedOutPayments} stale pending WiFi payment(s) as failed`);
  const applied = await applyPendingBatch();
  await touchOutageHeartbeat(prisma);
  await activateScheduledPromo();
  await endExpiredPromo();
  const expiredKicked = await kickSessionsWithoutCredentials();
  if (expiredKicked > 0) console.log(`Disconnected ${expiredKicked} session(s) whose access has ended`);
  const staleClosed = await closeStaleSessions();
  if (staleClosed > 0) console.log(`Closed ${staleClosed} stale RADIUS session(s)`);

  const accounting = await evaluateAccountingOutage(prisma);
  if (accounting.paused) {
    console.log(`Paused ${accounting.pausedCount} active WiFi entitlement(s): RADIUS accounting has been silent fleet-wide (network path likely down)`);
  }

  const resumed = await resumePausedEntitlements(prisma);
  if (resumed.resumed > 0) {
    console.log(`Resumed ${resumed.resumed} entitlement(s) on reconnect, credited ${resumed.totalCreditedSeconds}s total`);
  }

  if (applied > 0) console.log(`Applied ${applied} RADIUS projection(s)`);
}

async function main() {
  if (!config.radiusSql.enabled) {
    console.log("CAPTYN WiFi RADIUS SQL worker disabled");
    return;
  }

  console.log("CAPTYN WiFi RADIUS SQL worker running");
  const startupCheck = await applyOutageCredit(prisma);
  if (startupCheck.paused) {
    console.log(`Paused ${startupCheck.pausedCount} active WiFi entitlement(s): worker was down for ${startupCheck.outageSeconds}s`);
  }

  for (;;) {
    try {
      await tick();
    } catch (error) {
      console.error("CAPTYN WiFi RADIUS SQL worker error:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, config.radiusSql.pollIntervalMs));
  }
}

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

void main();
