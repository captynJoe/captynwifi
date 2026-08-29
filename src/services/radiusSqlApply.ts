import type { Prisma } from "@prisma/client";

type RadiusAttribute = {
  attribute?: unknown;
  op?: unknown;
  value?: unknown;
};

function asRadiusAttributes(value: Prisma.JsonValue): RadiusAttribute[] {
  return Array.isArray(value) ? (value as RadiusAttribute[]) : [];
}

function cleanText(value: unknown, fallback = "") {
  const text = String(value ?? fallback).trim();
  return text.slice(0, 253);
}

function cleanOperator(value: unknown, fallback: ":=" | "==") {
  const text = String(value ?? fallback).trim();
  return text === ":=" || text === "==" || text === "=" || text === "+=" ? text : fallback;
}

/**
 * Writes one projection's checkItems/replyItems straight into the FreeRADIUS
 * SQL tables (radcheck/radreply), replacing any existing rows for that
 * username. Shared by the async radiusSqlWorker poll loop and by voucher
 * issuance, which applies synchronously at creation time so a voucher is
 * redeemable the instant it's handed to a customer instead of waiting up to
 * one worker poll interval (CAPTYN_WIFI_RADIUS_SQL_POLL_INTERVAL_MS).
 */
export async function replaceRadiusRows(
  tx: Prisma.TransactionClient,
  table: "radcheck" | "radreply",
  username: string,
  items: RadiusAttribute[]
) {
  if (table === "radcheck") {
    await tx.$executeRaw`DELETE FROM radcheck WHERE username = ${username}`;
  } else {
    await tx.$executeRaw`DELETE FROM radreply WHERE username = ${username}`;
  }

  for (const item of items) {
    const attribute = cleanText(item.attribute, "");
    const value = cleanText(item.value, "");
    if (!attribute || !value) continue;
    const op = cleanOperator(item.op, table === "radcheck" ? ":=" : ":=");
    if (table === "radcheck") {
      await tx.$executeRaw`INSERT INTO radcheck (username, attribute, op, value) VALUES (${username}, ${attribute}, ${op}, ${value})`;
    } else {
      await tx.$executeRaw`INSERT INTO radreply (username, attribute, op, value) VALUES (${username}, ${attribute}, ${op}, ${value})`;
    }
  }
}

export async function applyRadiusProjectionRows(
  tx: Prisma.TransactionClient,
  username: string,
  checkItems: Prisma.JsonValue,
  replyItems: Prisma.JsonValue
) {
  await replaceRadiusRows(tx, "radcheck", username, asRadiusAttributes(checkItems));
  await replaceRadiusRows(tx, "radreply", username, asRadiusAttributes(replyItems));
}

/**
 * `username` on WifiEntitlement is the customer's phone number (or a free
 * grant's device-MAC-derived id), and repeat customers reuse it across every
 * purchase -- radcheck/radreply are keyed on that same username, not on any
 * per-entitlement id. If entitlement A (an old, now-expiring purchase) is
 * cleaned up while entitlement B (a newer purchase, same phone number) is
 * still active, a delete-by-username would erase B's live RADIUS credentials
 * along with A's, locking out a paying customer with time still on the
 * clock. Callers must check this before deleting radcheck/radreply for a
 * no-longer-active entitlement, and skip the delete if it's true --
 * whichever entitlement is still active already owns (or will shortly
 * re-own, via its own apply) those rows.
 */
export async function hasOtherActiveEntitlement(
  tx: Prisma.TransactionClient,
  username: string,
  excludeEntitlementId: string,
  at: Date
) {
  const other = await tx.wifiEntitlement.findFirst({
    where: { username, id: { not: excludeEntitlementId }, status: "active", expiresAt: { gt: at } },
    select: { id: true }
  });
  return Boolean(other);
}
