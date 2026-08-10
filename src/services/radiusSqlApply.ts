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
