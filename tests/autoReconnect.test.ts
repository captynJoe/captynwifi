import assert from "node:assert/strict";
import test from "node:test";
import { identityMatches, planAutoReconnect, RECONNECT_RECENT_MS, RECONNECT_RETRY_MS, type ReconnectCandidate } from "../src/services/autoReconnect.js";

const MAC = "86:82:B6:94:3F:FB";
const NOW = Date.parse("2026-11-24T08:00:00Z");
const phone = { hostName: "Galaxy-A-16", dhcpClassId: "android-dhcp-16", dhcpClientId: "1:86:82:b6:94:3f:fb" };
const host = (identity = phone) => ({ deviceMac: MAC, address: "192.168.88.50", identity });
const candidate = (overrides: Partial<ReconnectCandidate> = {}): ReconnectCandidate => ({
  entitlementId: "e1", username: "PKG-1", password: "pw", deviceMac: MAC,
  lastSeenAt: new Date(NOW - 10 * 60 * 1000), identity: phone, ...overrides
});

test("signs a dropped device back in when its identity still matches", () => {
  const plan = planAutoReconnect([host()], new Map([[MAC, [candidate()]]]), new Map(), NOW);
  assert.equal(plan.signIn.length, 1);
  assert.equal(plan.signIn[0].candidate.username, "PKG-1");
});

test("a copied MAC with a different device name is not signed in", () => {
  const plan = planAutoReconnect([host({ ...phone, hostName: "Someones-Laptop" })], new Map([[MAC, [candidate()]]]), new Map(), NOW);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["identity_mismatch"]);
});

test("never trusts a MAC alone: no recorded identity, no sign-in", () => {
  const blank = { hostName: null, dhcpClassId: null, dhcpClientId: null };
  assert.equal(identityMatches(blank, phone), null);
  const plan = planAutoReconnect([host()], new Map([[MAC, [candidate({ identity: blank })]]]), new Map(), NOW);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["no_identity"]);
});

test("skips devices not seen on the package recently", () => {
  const plan = planAutoReconnect([host()], new Map([[MAC, [candidate({ lastSeenAt: new Date(NOW - RECONNECT_RECENT_MS - 1000) })]]]), new Map(), NOW);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["not_recent"]);
});

test("waits between attempts so a refused device doesn't loop", () => {
  const plan = planAutoReconnect([host()], new Map([[MAC, [candidate()]]]), new Map([[MAC, NOW - RECONNECT_RETRY_MS + 5000]]), NOW);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["retry_wait"]);
});

test("goes back to the package the device was most recently on", () => {
  const plan = planAutoReconnect([host()], new Map([[MAC, [
    candidate({ username: "PKG-OLDER", lastSeenAt: new Date(NOW - 3 * 60 * 60 * 1000) }),
    candidate({ username: "PKG-NEWER", lastSeenAt: new Date(NOW - 5 * 60 * 1000) })
  ]]]), new Map(), NOW);
  assert.equal(plan.signIn[0].candidate.username, "PKG-NEWER");
});

test("ignores devices that belong to no package", () => {
  const plan = planAutoReconnect([host()], new Map(), new Map(), NOW);
  assert.deepEqual(plan, { signIn: [], skipped: [] });
});
