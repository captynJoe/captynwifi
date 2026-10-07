import assert from "node:assert/strict";
import { test } from "node:test";
import { addDeviceQuote, deviceOptions, devicePrice } from "../src/services/devicePricing.js";

const cruise3h = { priceKsh: 12, deviceLimit: 1, maxDevices: 3 };
const dayPass = { priceKsh: 45, deviceLimit: 1, maxDevices: 3 };
const twoDevicePackage = { priceKsh: 32, deviceLimit: 2, maxDevices: 3 };

test("prices scale by 1.6x for 2 devices and 2.1x for 3", () => {
  assert.deepEqual(deviceOptions(cruise3h), [{ devices: 1, priceKsh: 12 }, { devices: 2, priceKsh: 19 }, { devices: 3, priceKsh: 25 }]);
  assert.equal(devicePrice(dayPass, 2), 72);
  assert.equal(devicePrice(dayPass, 3), 95);
});

test("packages that start at 2 devices scale from there", () => {
  assert.deepEqual(deviceOptions(twoDevicePackage), [{ devices: 2, priceKsh: 32 }, { devices: 3, priceKsh: 42 }]);
});

test("maxDevices limits the selector and free packages get none", () => {
  assert.equal(deviceOptions({ priceKsh: 30, deviceLimit: 1, maxDevices: 1 }).length, 1);
  assert.equal(deviceOptions({ priceKsh: 0, deviceLimit: 1, maxDevices: 3 }).length, 1);
});

test("adding a device costs the difference for the time left", () => {
  const startsAt = new Date("2026-10-07T00:00:00Z");
  const expiresAt = new Date("2026-10-08T00:00:00Z");
  const halfway = new Date("2026-10-07T12:00:00Z");
  // (72 - 45) * 0.5 = 13.5 -> 14
  assert.equal(addDeviceQuote(dayPass, { deviceLimit: 1, startsAt, expiresAt }, 2, halfway), 14);
  assert.equal(addDeviceQuote(dayPass, { deviceLimit: 1, startsAt, expiresAt }, 2, new Date("2026-10-07T23:59:00Z")), 1);
});
