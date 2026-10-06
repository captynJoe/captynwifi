// Mirrors captyn_device_cap() in the wifi_device_ledger migration, which
// FreeRADIUS enforces at sign-in: different devices allowed over a package's
// life are its concurrent device limit plus 1 switch for packages up to a
// day, or plus 2 for longer ones. Keep the two in step.
export function deviceCap(entitlement: { deviceLimit: number; startsAt: Date; expiresAt: Date }): number {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const lengthMs = entitlement.expiresAt.getTime() - entitlement.startsAt.getTime();
  return entitlement.deviceLimit + (lengthMs <= oneDayMs ? 1 : 2);
}

export function publicDevice(device: { deviceMac: string; label: string | null; addedAt: Date; lastSeenAt: Date | null; signedOutAt: Date | null }) {
  return {
    deviceMac: device.deviceMac,
    label: device.label,
    addedAt: device.addedAt,
    lastSeenAt: device.lastSeenAt,
    signedOut: Boolean(device.signedOutAt)
  };
}
