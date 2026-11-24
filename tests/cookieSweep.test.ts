import assert from "node:assert/strict";
import test from "node:test";
import { planCookieSweep, planExpiredSessionSweep, type CookieSweepFacts } from "../src/services/cookieSweep.js";

const MAC_A = "EA:DB:24:D1:C1:4A";
const MAC_B = "B6:E7:F2:F6:0F:EB";

function facts(overrides: Partial<CookieSweepFacts>): CookieSweepFacts {
  return {
    cookies: [],
    knownUsernames: new Set(["PKG-SHARED", "PKG-OLD", "PKG-FRIEND"]),
    activeUsernames: new Set(["PKG-SHARED", "PKG-FRIEND"]),
    signedOutDevices: new Set(),
    onlineAs: new Map(),
    ...overrides
  };
}

test("keeps the cookie of a device that belongs to its active package", () => {
  const plan = planCookieSweep(facts({ cookies: [{ id: "*1", user: "PKG-SHARED", deviceMac: MAC_A }], onlineAs: new Map([[MAC_A, "PKG-SHARED"]]) }));
  assert.deepEqual(plan, []);
});

test("removes cookies for packages that have ended", () => {
  const plan = planCookieSweep(facts({ cookies: [{ id: "*2", user: "PKG-OLD", deviceMac: MAC_B }] }));
  assert.deepEqual(plan.map((p) => p.reason), ["package_inactive"]);
});

test("removes the cookie of a device signed out of the package, so the sign-out sticks", () => {
  const plan = planCookieSweep(facts({
    cookies: [{ id: "*3", user: "PKG-SHARED", deviceMac: MAC_A }],
    signedOutDevices: new Set([`PKG-SHARED|${MAC_A}`])
  }));
  assert.deepEqual(plan.map((p) => p.reason), ["device_signed_out"]);
});

test("one device, one package: a cookie for another package goes once the device is online elsewhere", () => {
  const plan = planCookieSweep(facts({
    cookies: [
      { id: "*4", user: "PKG-SHARED", deviceMac: MAC_B },
      { id: "*5", user: "PKG-FRIEND", deviceMac: MAC_B }
    ],
    onlineAs: new Map([[MAC_B, "PKG-SHARED"]])
  }));
  assert.deepEqual(plan.map((p) => [p.cookie.id, p.reason]), [["*5", "device_on_other_package"]]);
});

test("leaves cookies for usernames CAPTYN never issued", () => {
  const plan = planCookieSweep(facts({ cookies: [{ id: "*6", user: "staff-laptop", deviceMac: MAC_A }] }));
  assert.deepEqual(plan, []);
});

test("does not remove a cookie just because the device is offline", () => {
  const plan = planCookieSweep(facts({ cookies: [{ id: "*7", user: "PKG-FRIEND", deviceMac: MAC_A }] }));
  assert.deepEqual(plan, []);
});

test("logs off a package that ended but is still online", () => {
  const users = planExpiredSessionSweep(
    [{ user: "PKG-OLD", deviceMac: MAC_A }, { user: "PKG-SHARED", deviceMac: MAC_B }],
    new Set(["PKG-OLD", "PKG-SHARED"]),
    new Set(["PKG-SHARED"])
  );
  assert.deepEqual(users, ["PKG-OLD"]);
});

test("never logs off a session CAPTYN didn't issue, or one with an active package", () => {
  const users = planExpiredSessionSweep(
    [{ user: "staff-laptop", deviceMac: MAC_A }, { user: "PKG-SHARED", deviceMac: MAC_B }, { user: "PKG-SHARED", deviceMac: MAC_A }],
    new Set(["PKG-SHARED"]),
    new Set(["PKG-SHARED"])
  );
  assert.deepEqual(users, []);
});
