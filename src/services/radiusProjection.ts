import { randomBytes } from "node:crypto";
import { config } from "../config.js";

export type RadiusAttribute = {
  attribute: string;
  op: ":=" | "=" | "+=";
  value: string | number;
};

export type BuildEntitlementInput = {
  entitlementId: string;
  phone: string;
  username?: string;
  password?: string;
  deviceMac?: string | null;
  expiresAt: Date;
  durationSeconds: number;
  rateLimit?: string | null;
  deviceLimit: number;
};

export function normalizeDeviceMac(mac?: string | null): string | null {
  const trimmed = String(mac ?? "").trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

export function normalizeWifiUsername(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  return digits || `wifi${randomBytes(3).toString("hex")}`;
}

export function createRadiusSecret(): string {
  return randomBytes(12).toString("base64url");
}

export function buildRadiusProjection(input: BuildEntitlementInput) {
  const username = input.username ?? normalizeWifiUsername(input.phone);
  const password = input.password ?? createRadiusSecret();
  const sessionTimeout = Math.max(60, Math.round(input.durationSeconds));
  const interim = config.defaultAcctInterimSeconds;

  const checkItems: RadiusAttribute[] = [
    { attribute: "User-Name", op: ":=", value: username },
    { attribute: "Cleartext-Password", op: ":=", value: password }
  ];

  const replyItems: RadiusAttribute[] = [
    { attribute: "Session-Timeout", op: ":=", value: sessionTimeout },
    { attribute: "Idle-Timeout", op: ":=", value: 900 },
    { attribute: "Port-Limit", op: ":=", value: input.deviceLimit },
    { attribute: "Acct-Interim-Interval", op: ":=", value: interim },
    { attribute: "WISPr-Session-Terminate-Time", op: ":=", value: input.expiresAt.toISOString() },
    { attribute: "Class", op: ":=", value: `entitlement:${input.entitlementId}` }
  ];

  if (input.rateLimit) {
    replyItems.unshift({ attribute: "Mikrotik-Rate-Limit", op: ":=", value: input.rateLimit });
  }

  return {
    username,
    password,
    checkItems,
    replyItems
  };
}
