import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { normalizeDeviceMac } from "./radiusProjection.js";
import { signInHotspotDevice, type HotspotSignInResult } from "./routeros.js";

type SignInEntitlement = { id: string; username: string; cleartextSecret: string };

// Signs one of a package's devices into the hotspot from the server and
// records the device's DHCP identity against the package. RADIUS still
// decides (device cap, Simultaneous-Use) and records the device itself in
// post-auth; this only adds the identity that later automatic sign-ins check.
export async function signInEntitlementDevice(
  prisma: PrismaClient,
  entitlement: SignInEntitlement,
  deviceMacRaw: string
): Promise<HotspotSignInResult> {
  if (!config.routeros.serverSignIn) {
    return { signedIn: false, alreadyOnline: false, identity: null, skippedReason: "Server sign-in is off" };
  }
  const deviceMac = normalizeDeviceMac(deviceMacRaw);
  if (!deviceMac) return { signedIn: false, alreadyOnline: false, identity: null, skippedReason: "Device MAC required" };

  const result = await signInHotspotDevice({ username: entitlement.username, password: entitlement.cleartextSecret, deviceMac });
  if ((result.signedIn || result.alreadyOnline) && result.identity) {
    const now = new Date();
    const identity = { ...result.identity, identitySeenAt: now, lastSeenAt: now };
    const save = result.signedIn
      // This package just signed the device in, so it belongs here. RADIUS
      // post-auth may insert the same row at the same moment; upsert only
      // fills in identity.
      ? prisma.wifiEntitlementDevice.upsert({
          where: { entitlementId_deviceMac: { entitlementId: entitlement.id, deviceMac } },
          create: { entitlementId: entitlement.id, deviceMac, ...identity },
          update: identity
        })
      // Already online may be under another package: refresh identity on a
      // device this package already has, never add one.
      : prisma.wifiEntitlementDevice.updateMany({ where: { entitlementId: entitlement.id, deviceMac }, data: identity });
    await save.catch((error) => console.warn(`[SignIn] identity not saved for ${deviceMac}:`, error instanceof Error ? error.message : error));
  }
  if (result.error) console.warn(`[SignIn] ${entitlement.username} ${deviceMac}: ${result.error}`);
  return result;
}
