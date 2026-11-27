import crypto from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { CONNECT_CODE_ALPHABET } from "./connectCode.js";
import { AccountError } from "./account.js";

// Housing -> WiFi link codes. 7 characters, so the portal's code box tells
// them apart from 6-character device codes and 8+ character vouchers.
export const LINK_CODE_LENGTH = 7;
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

export function generateLinkCode() {
  let code = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) code += CONNECT_CODE_ALPHABET[crypto.randomInt(CONNECT_CODE_ALPHABET.length)];
  return code;
}

export function normalizeLinkCode(raw: string): string | null {
  const code = String(raw ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== LINK_CODE_LENGTH) return null;
  return [...code].every((char) => CONNECT_CODE_ALPHABET.includes(char)) ? code : null;
}

// A new code replaces any unused one for the same phone.
export async function createLinkCode(
  prisma: PrismaClient,
  input: { phone: string; buildingId: string; houseNumber: string; tenancyId: string },
  now = new Date()
) {
  await prisma.wifiLinkCode.updateMany({ where: { phone: input.phone, usedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.wifiLinkCode.create({ data: { ...input, code: generateLinkCode(), expiresAt: new Date(now.getTime() + LINK_CODE_TTL_MS) } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
  }
  throw new Error("Could not allocate a link code");
}

// Marks the code used (once) and returns who it belongs to.
export async function redeemLinkCode(prisma: PrismaClient, rawCode: string, deviceMac: string | null, now = new Date()) {
  const code = normalizeLinkCode(rawCode);
  if (!code) throw new AccountError("Check the code: it's 7 letters and numbers from the Housing app.", 400, "link_code_invalid");
  const record = await prisma.wifiLinkCode.findUnique({ where: { code } });
  if (!record || record.usedAt) throw new AccountError("That code isn't valid. Get a new one in the Housing app.", 404, "link_code_invalid");
  if (record.expiresAt <= now) throw new AccountError("That code has expired. Get a new one in the Housing app.", 410, "link_code_expired");
  const claimed = await prisma.wifiLinkCode.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: now, deviceMac } });
  if (claimed.count !== 1) throw new AccountError("That code has already been used.", 409, "link_code_used");
  return record;
}
