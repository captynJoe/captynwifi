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

// A payment from a device the running package has never seen only tops up
// time -- RADIUS still lets in deviceLimit devices at once -- so when every
// slot is taken by a device that hasn't signed out, the payer pays and stays
// offline. Those payments must add a device instead.
export function payingDeviceNeedsSlot(
  entitlement: { deviceLimit: number; deviceMac: string | null },
  devices: Array<{ deviceMac: string; signedOutAt: Date | null }>,
  mac: string
): boolean {
  if (entitlement.deviceMac === mac || devices.some((device) => device.deviceMac === mac)) return false;
  return devices.filter((device) => !device.signedOutAt).length >= entitlement.deviceLimit;
}
