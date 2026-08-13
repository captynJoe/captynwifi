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

function secondsBetween(start: Date, end: Date) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
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
