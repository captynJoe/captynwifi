import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceCap } from "../src/services/deviceLedger.js";

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
