import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceCap, payingDeviceNeedsSlot } from "../src/services/deviceLedger.js";

const start = new Date("2026-10-07T08:00:00Z");
const after = (hours: number) => new Date(start.getTime() + hours * 3600 * 1000);

test("packages up to a day allow one switch beyond the device limit", () => {
  assert.equal(deviceCap({ deviceLimit: 1, startsAt: start, expiresAt: after(3) }), 2);
  assert.equal(deviceCap({ deviceLimit: 1, startsAt: start, expiresAt: after(24) }), 2);
  assert.equal(deviceCap({ deviceLimit: 2, startsAt: start, expiresAt: after(5) }), 3);
});

test("longer packages allow two switches", () => {
  assert.equal(deviceCap({ deviceLimit: 1, startsAt: start, expiresAt: after(48) }), 3);
  assert.equal(deviceCap({ deviceLimit: 2, startsAt: start, expiresAt: after(720) }), 4);
});

test("a new device paying into a full package needs a slot, a known one doesn't", () => {
  const phone = { deviceMac: "2E:CF:79:12:07:CF", signedOutAt: null };
  const laptop = "4A:B6:14:B2:2F:2D";
  const pkg = { deviceLimit: 1, deviceMac: phone.deviceMac };
  assert.equal(payingDeviceNeedsSlot(pkg, [phone], laptop), true);
  assert.equal(payingDeviceNeedsSlot(pkg, [phone], phone.deviceMac), false);
  assert.equal(payingDeviceNeedsSlot({ ...pkg, deviceMac: null }, [phone, { deviceMac: laptop, signedOutAt: start }], laptop), false);
  assert.equal(payingDeviceNeedsSlot({ deviceLimit: 2, deviceMac: phone.deviceMac }, [phone], laptop), false);
  assert.equal(payingDeviceNeedsSlot(pkg, [{ ...phone, signedOutAt: start }], laptop), false);
});
