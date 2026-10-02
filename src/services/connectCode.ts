import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

// No 0/O, 1/I/L: the code is read off one screen and typed on another.
const CONNECT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CONNECT_CODE_LENGTH = 6;

export function generateConnectCode(): string {
  let code = "";
  for (let i = 0; i < CONNECT_CODE_LENGTH; i += 1) {
    code += CONNECT_CODE_ALPHABET[crypto.randomInt(CONNECT_CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeConnectCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== CONNECT_CODE_LENGTH) return null;
  for (const char of code) {
    if (!CONNECT_CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}

// Assigned lazily the first time the owner's connected device asks for it,
// rather than at every entitlement-creation site.
export async function ensureConnectCode(prisma: PrismaClient, entitlement: { id: string; connectCode: string | null }): Promise<string> {
  if (entitlement.connectCode) return entitlement.connectCode;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateConnectCode();
    try {
      const updated = await prisma.wifiEntitlement.updateMany({
        where: { id: entitlement.id, connectCode: null },
        data: { connectCode: code }
      });
      if (updated.count === 1) return code;
      // Another request assigned one first -- use theirs.
      const current = await prisma.wifiEntitlement.findUnique({ where: { id: entitlement.id }, select: { connectCode: true } });
      if (current?.connectCode) return current.connectCode;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      throw error;
    }
  }
  throw new Error("Could not assign a unique connect code");
}
