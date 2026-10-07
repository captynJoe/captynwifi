// Device selector pricing. One rule for every package: the price scales by
// these multipliers relative to the package's own starting device count, so
// a package that starts at 2 devices charges 2.1/1.6 of its price for 3.
// Each device gets its own full speed (MikroTik limits per session), so
// extra devices cost real bandwidth -- but stay cheaper than separate packages.
export const MAX_DEVICES = 3;
export const DEVICE_PRICE_MULTIPLIERS: Record<number, number> = { 1: 1, 2: 1.6, 3: 2.1 };

type PricedPlan = { priceKsh: number; deviceLimit: number; maxDevices: number };

function multiplier(devices: number): number {
  return DEVICE_PRICE_MULTIPLIERS[Math.min(MAX_DEVICES, Math.max(1, Math.round(devices)))];
}

export function maxDevicesFor(plan: PricedPlan): number {
  if (plan.priceKsh <= 0) return plan.deviceLimit;
  return Math.max(plan.deviceLimit, Math.min(MAX_DEVICES, plan.maxDevices));
}

export function devicePrice(plan: PricedPlan, devices: number): number {
  if (devices <= plan.deviceLimit) return plan.priceKsh;
  return Math.round((plan.priceKsh * multiplier(devices)) / multiplier(plan.deviceLimit));
}

export function deviceOptions(plan: PricedPlan): Array<{ devices: number; priceKsh: number }> {
  const options: Array<{ devices: number; priceKsh: number }> = [];
  for (let devices = plan.deviceLimit; devices <= maxDevicesFor(plan); devices += 1) {
    options.push({ devices, priceKsh: devicePrice(plan, devices) });
  }
  return options;
}

// Adding devices to a running package costs the price difference for one
// package, scaled by the time left measured in package lengths. Measured
// against the package's own duration -- not the access record's span, which
// top-ups stretch -- so a Day Pass topped up to 72h with 48h left pays
// 2 x the daily difference, not a third of it. Minimum KSh 1.
export function addDeviceQuote(
  plan: PricedPlan & { durationSeconds: number },
  entitlement: { deviceLimit: number; expiresAt: Date },
  devices: number,
  now = new Date()
): number {
  const difference = devicePrice(plan, devices) - devicePrice(plan, entitlement.deviceLimit);
  const leftMs = Math.max(0, entitlement.expiresAt.getTime() - now.getTime());
  const packageMs = plan.durationSeconds * 1000;
  const lengths = packageMs > 0 ? leftMs / packageMs : 1;
  return Math.max(1, Math.ceil(difference * lengths));
}
