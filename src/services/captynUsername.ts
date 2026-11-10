import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

const CALLSIGNS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL", "INDIA", "JULIET", "KILO", "LIMA", "MIKE", "NOVEMBER", "OSCAR", "PAPA", "QUEBEC", "ROMEO", "SIERRA", "TANGO", "UNIFORM", "VICTOR", "WHISKEY", "XRAY", "YANKEE", "ZULU"] as const;
const BRAND = ["GLOBAL", "CAPTYN", "JETSTREAM", "DISCOVERY"] as const;
const SUFFIX = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function randomWord<T extends readonly string[]>(words: T): T[number] {
  return words[crypto.randomInt(words.length)];
}

/** Human-readable CAPTYN WiFi login; randomness keeps the phrase unguessable. */
export function generateCaptynWifiUsername(): string {
  const suffix = Array.from({ length: 4 }, () => SUFFIX[crypto.randomInt(SUFFIX.length)]).join("");
  return `CG-${randomWord(BRAND)}-${randomWord(CALLSIGNS)}-${suffix}`;
}

export async function createUniqueCaptynWifiUsername(db: PrismaClient | Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const username = generateCaptynWifiUsername();
    const [entitlement, pppoeAccount] = await Promise.all([
      db.wifiEntitlement.findFirst({ where: { username }, select: { id: true } }),
      db.wifiPppoeAccount.findUnique({ where: { username }, select: { id: true } })
    ]);
    if (!entitlement && !pppoeAccount) return username;
  }
  throw new Error("Could not allocate a unique CAPTYN WiFi username");
}
