import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { listWaitingHotspotHosts, loginHotspotHost, type HotspotDeviceIdentity, type WaitingHotspotHost } from "./routeros.js";

export const RECONNECT_RECENT_MS = 12 * 60 * 60 * 1000;
export const RECONNECT_RETRY_MS = 2 * 60 * 1000;

export type ReconnectCandidate = {
  entitlementId: string;
  username: string;
  password: string;
  deviceMac: string;
  lastSeenAt: Date | null;
  identity: HotspotDeviceIdentity;
};

export type ReconnectSkip = "no_identity" | "identity_mismatch" | "not_recent" | "retry_wait";

// The identity recorded when CAPTYN signed the device in must still match the
// router's DHCP lease, field by field, and at least one field must have been
// recorded -- a MAC alone is never enough to sign a device in.
export function identityMatches(recorded: HotspotDeviceIdentity, current: HotspotDeviceIdentity): boolean | null {
  const fields: Array<keyof HotspotDeviceIdentity> = ["hostName", "dhcpClassId", "dhcpClientId"];
  const known = fields.filter((field) => recorded[field]);
  if (known.length === 0) return null;
  return known.every((field) => (current[field] || "").toLowerCase() === (recorded[field] || "").toLowerCase());
}

// Which waiting devices to sign back in, and why the rest were skipped.
// A device with packages on more than one active entitlement goes back to the
// one it was most recently on.
export function planAutoReconnect(
  hosts: WaitingHotspotHost[],
  candidatesByMac: Map<string, ReconnectCandidate[]>,
  lastAttemptAt: Map<string, number>,
  now = Date.now()
) {
  const signIn: Array<{ host: WaitingHotspotHost; candidate: ReconnectCandidate }> = [];
  const skipped: Array<{ deviceMac: string; username: string; reason: ReconnectSkip }> = [];
  for (const host of hosts) {
    const candidates = [...(candidatesByMac.get(host.deviceMac) ?? [])]
      .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0));
    const candidate = candidates[0];
    if (!candidate) continue;
    const skip = (reason: ReconnectSkip) => skipped.push({ deviceMac: host.deviceMac, username: candidate.username, reason });
    const match = identityMatches(candidate.identity, host.identity);
    if (match === null) { skip("no_identity"); continue; }
    if (!match) { skip("identity_mismatch"); continue; }
    if (!candidate.lastSeenAt || now - candidate.lastSeenAt.getTime() > RECONNECT_RECENT_MS) { skip("not_recent"); continue; }
    const last = lastAttemptAt.get(host.deviceMac);
    if (last !== undefined && now - last < RECONNECT_RETRY_MS) { skip("retry_wait"); continue; }
    signIn.push({ host, candidate });
  }
  return { signIn, skipped };
}

const lastAttemptAt = new Map<string, number>();

export async function runAutoReconnect(prisma: PrismaClient) {
  const mode = config.routeros.autoReconnect;
  if (mode === "off") return null;
  const hosts = await listWaitingHotspotHosts();
  if (!hosts || hosts.length === 0) return hosts ? { mode, waiting: 0, signedIn: 0, failed: 0 } : null;

  const now = new Date();
  const devices = await prisma.wifiEntitlementDevice.findMany({
    where: {
      deviceMac: { in: hosts.map((host) => host.deviceMac) },
      signedOutAt: null,
      // Paused packages are refused by RADIUS anyway; don't try.
      entitlement: { status: "active", expiresAt: { gt: now }, outagePausedAt: null, promoPausedAt: null }
    },
    select: {
      deviceMac: true, lastSeenAt: true, hostName: true, dhcpClassId: true, dhcpClientId: true,
      entitlement: { select: { id: true, username: true, cleartextSecret: true } }
    }
  });
  // lastSeenAt only moves on sign-in; a phone online all day then dropped
  // would look stale. Its latest accounting report is the real "last seen".
  const lastActivity = new Map<string, Date>();
  if (devices.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ username: string; mac: string; at: Date }>>`
      SELECT username, upper(callingstationid) AS mac, max(coalesce(acctstoptime, acctupdatetime, acctstarttime)) AS at
      FROM radacct
      WHERE upper(callingstationid) = ANY(${[...new Set(devices.map((d) => d.deviceMac))]})
        AND acctstarttime > now() - interval '2 days'
      GROUP BY 1, 2`;
    for (const row of rows) lastActivity.set(`${row.username}|${row.mac}`, row.at);
  }
  const candidatesByMac = new Map<string, ReconnectCandidate[]>();
  for (const device of devices) {
    const activity = lastActivity.get(`${device.entitlement.username}|${device.deviceMac}`);
    const lastSeenAt = [device.lastSeenAt, activity].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const list = candidatesByMac.get(device.deviceMac) ?? [];
    list.push({
      entitlementId: device.entitlement.id,
      username: device.entitlement.username,
      password: device.entitlement.cleartextSecret,
      deviceMac: device.deviceMac,
      lastSeenAt,
      identity: { hostName: device.hostName, dhcpClassId: device.dhcpClassId, dhcpClientId: device.dhcpClientId }
    });
    candidatesByMac.set(device.deviceMac, list);
  }

  const plan = planAutoReconnect(hosts, candidatesByMac, lastAttemptAt, now.getTime());
  for (const skip of plan.skipped) {
    if (skip.reason !== "retry_wait") console.log(`[AutoReconnect] skip ${skip.reason}: ${skip.username} ${skip.deviceMac}`);
  }
  let signedIn = 0;
  let failed = 0;
  for (const { host, candidate } of plan.signIn) {
    console.log(`[AutoReconnect]${mode === "dry-run" ? " (dry run)" : ""} sign in ${candidate.username} ${host.deviceMac} ${host.address}`);
    if (mode !== "on") continue;
    lastAttemptAt.set(host.deviceMac, now.getTime());
    const result = await loginHotspotHost({ username: candidate.username, password: candidate.password, deviceMac: host.deviceMac, address: host.address });
    if (result.ok) {
      signedIn += 1;
    } else {
      failed += 1;
      console.warn(`[AutoReconnect] ${candidate.username} ${host.deviceMac}: ${result.error}`);
    }
  }
  // Forget attempts long past the retry window so the map can't grow forever.
  for (const [mac, at] of lastAttemptAt) if (now.getTime() - at > RECONNECT_RETRY_MS * 5) lastAttemptAt.delete(mac);
  return { mode, waiting: hosts.length, planned: plan.signIn.length, signedIn, failed };
}
