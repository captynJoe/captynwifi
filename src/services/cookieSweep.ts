import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { listActiveHotspotSessions, listHotspotCookies, removeHotspotCookies, type HotspotCookie } from "./routeros.js";

export type CookieSweepReason = "package_inactive" | "device_signed_out" | "device_on_other_package";

export type CookieSweepFacts = {
  cookies: HotspotCookie[];
  // Usernames of WiFi packages that exist in CAPTYN at all, and of those
  // still active. A username CAPTYN has never issued is left alone.
  knownUsernames: Set<string>;
  activeUsernames: Set<string>;
  // `${username}|${MAC}` for devices signed out of an active package.
  signedOutDevices: Set<string>;
  // MAC -> username of the router session it is online under right now.
  onlineAs: Map<string, string>;
};

// Which of the router's mac-cookies would sign a device in where it no
// longer belongs. One device, one package: a cookie survives only while its
// package is active, the device hasn't been signed out of it, and the device
// isn't online under a different package.
export function planCookieSweep(facts: CookieSweepFacts): Array<{ cookie: HotspotCookie; reason: CookieSweepReason }> {
  const plan: Array<{ cookie: HotspotCookie; reason: CookieSweepReason }> = [];
  for (const cookie of facts.cookies) {
    if (!facts.knownUsernames.has(cookie.user)) continue;
    if (!facts.activeUsernames.has(cookie.user)) {
      plan.push({ cookie, reason: "package_inactive" });
    } else if (facts.signedOutDevices.has(`${cookie.user}|${cookie.deviceMac}`)) {
      plan.push({ cookie, reason: "device_signed_out" });
    } else {
      const online = facts.onlineAs.get(cookie.deviceMac);
      if (online && online !== cookie.user) plan.push({ cookie, reason: "device_on_other_package" });
    }
  }
  return plan;
}

export async function sweepHotspotCookies(prisma: PrismaClient) {
  const mode = config.routeros.cookieSweep;
  if (mode === "off") return null;

  const [cookies, sessions] = await Promise.all([listHotspotCookies(), listActiveHotspotSessions()]);
  // Without both lists the "online under another package" rule can't be
  // judged; skip the round rather than act on half a picture.
  if (!cookies || !sessions) return null;
  if (cookies.length === 0) return { mode, cookies: 0, planned: 0, removed: 0 };

  const usernames = [...new Set(cookies.map((cookie) => cookie.user))];
  const now = new Date();
  const entitlements = await prisma.wifiEntitlement.findMany({
    where: { username: { in: usernames } },
    select: { id: true, username: true, status: true, expiresAt: true, outagePausedAt: true, promoPausedAt: true }
  });
  const active = entitlements.filter((e) => e.status === "active" && (e.expiresAt > now || e.outagePausedAt || e.promoPausedAt));
  const signedOut = active.length === 0 ? [] : await prisma.wifiEntitlementDevice.findMany({
    where: { entitlementId: { in: active.map((e) => e.id) }, signedOutAt: { not: null } },
    select: { entitlementId: true, deviceMac: true }
  });
  const usernameById = new Map(active.map((e) => [e.id, e.username]));

  const plan = planCookieSweep({
    cookies,
    knownUsernames: new Set(entitlements.map((e) => e.username)),
    activeUsernames: new Set(active.map((e) => e.username)),
    signedOutDevices: new Set(signedOut.map((d) => `${usernameById.get(d.entitlementId)}|${d.deviceMac.toUpperCase()}`)),
    onlineAs: new Map(sessions.map((s) => [s.deviceMac, s.user]))
  });

  for (const { cookie, reason } of plan) {
    console.log(`[CookieSweep]${mode === "dry-run" ? " (dry run)" : ""} ${reason}: ${cookie.user} ${cookie.deviceMac}`);
  }
  if (mode === "dry-run" || plan.length === 0) return { mode, cookies: cookies.length, planned: plan.length, removed: 0 };
  const result = await removeHotspotCookies(plan.map((entry) => entry.cookie.id));
  if (result.error) console.warn(`[CookieSweep] removal incomplete: ${result.error}`);
  return { mode, cookies: cookies.length, planned: plan.length, removed: result.removed };
}
