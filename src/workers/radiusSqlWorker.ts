import "dotenv/config";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { applyRadiusProjectionRows } from "../services/radiusSqlApply.js";
import { applyOutageCredit, evaluateAccountingOutage, touchOutageHeartbeat } from "../services/outageCredit.js";

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
      await tx.$executeRaw`DELETE FROM radcheck WHERE username = ${projection.username}`;
      await tx.$executeRaw`DELETE FROM radreply WHERE username = ${projection.username}`;
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
    where: { status: "active", expiresAt: { lte: now } },
    select: { id: true, username: true, projection: { select: { id: true, status: true } } },
    take: config.radiusSql.batchSize
  });

  for (const entitlement of expired) {
    await prisma.$transaction(async (tx) => {
      await tx.wifiEntitlement.update({ where: { id: entitlement.id }, data: { status: "expired" } });
      await tx.$executeRaw`DELETE FROM radcheck WHERE username = ${entitlement.username}`;
      await tx.$executeRaw`DELETE FROM radreply WHERE username = ${entitlement.username}`;
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

async function tick() {
  await expireEntitlements();
  const applied = await applyPendingBatch();
  await touchOutageHeartbeat(prisma);

  const accountingCredit = await evaluateAccountingOutage(prisma);
  if (accountingCredit.credited) {
    console.log(
      `Credited ${accountingCredit.affectedEntitlements} active WiFi entitlement(s) for ${accountingCredit.creditedSeconds}s of silent RADIUS accounting (network path likely down)`
    );
  }

  if (applied > 0) console.log(`Applied ${applied} RADIUS projection(s)`);
}

async function main() {
  if (!config.radiusSql.enabled) {
    console.log("CAPTYN WiFi RADIUS SQL worker disabled");
    return;
  }

  console.log("CAPTYN WiFi RADIUS SQL worker running");
  const credit = await applyOutageCredit(prisma);
  if (credit.credited) {
    console.log(
      `Credited ${credit.affectedEntitlements} active WiFi entitlement(s) for ${credit.creditedSeconds}s of CAPTYN-side downtime`
    );
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
