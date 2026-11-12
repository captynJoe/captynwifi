import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAccountingOutageAction, decideResumeAction, expiryFromFrozenBalance, confirmsCustomerPathOutage } from "../src/services/outageCredit.js";

const GRACE_SECONDS = 600;
const RECONNECT_WINDOW_SECONDS = 60 * 60 * 48;

test("RADIUS silence alone never confirms an outage when the router says Internet is up", () => {
  assert.equal(confirmsCustomerPathOutage(true, {
    configured: true,
    routerReachable: true,
    wanLinkUp: true,
    internetReachable: true,
    reachableTargets: ["1.1.1.1"],
    checkedAt: "2026-11-12T00:00:00.000Z"
  }), false);
});

test("an unreachable or unconfigured RouterOS probe is unknown, not outage confirmation", () => {
  assert.equal(confirmsCustomerPathOutage(true, {
    configured: true,
    routerReachable: false,
    wanLinkUp: null,
    internetReachable: null,
    reachableTargets: [],
    checkedAt: "2026-11-12T00:00:00.000Z",
    error: "timeout"
  }), false);
  assert.equal(confirmsCustomerPathOutage(true, {
    configured: false,
    routerReachable: false,
    wanLinkUp: null,
    internetReachable: null,
    reachableTargets: [],
    checkedAt: "2026-11-12T00:00:00.000Z"
  }), false);
});

test("RADIUS silence plus a reachable MikroTik reporting WAN or Internet loss confirms outage", () => {
  const base = {
    configured: true,
    routerReachable: true,
    reachableTargets: [],
    checkedAt: "2026-11-12T00:00:00.000Z"
  };
  assert.equal(confirmsCustomerPathOutage(true, { ...base, wanLinkUp: false, internetReachable: false }), true);
  assert.equal(confirmsCustomerPathOutage(true, { ...base, wanLinkUp: true, internetReachable: false }), true);
  assert.equal(confirmsCustomerPathOutage(false, { ...base, wanLinkUp: false, internetReachable: false }), false);
});

test("real activity moving forward advances the checkpoint and is never treated as an outage", () => {
  const checkpoint = new Date("2026-08-16T10:00:00Z");
  const lastActivity = new Date("2026-08-16T10:04:00Z");
  const now = new Date("2026-08-16T10:04:01Z");

  const decision = decideAccountingOutageAction(checkpoint, lastActivity, now, GRACE_SECONDS);
  assert.deepEqual(decision, { type: "advance", checkpoint: lastActivity });
});

test("a stale checkpoint within the grace window is not an outage yet", () => {
  const checkpoint = new Date("2026-08-16T10:00:00Z");
  const lastActivity = checkpoint;
  const now = new Date(checkpoint.getTime() + (GRACE_SECONDS - 1) * 1000);

  const decision = decideAccountingOutageAction(checkpoint, lastActivity, now, GRACE_SECONDS);
  assert.deepEqual(decision, { type: "healthy" });
});

test("a checkpoint stale beyond the grace window triggers a credit for the elapsed gap", () => {
  const checkpoint = new Date("2026-08-16T10:00:00Z");
  const lastActivity = checkpoint;
  const now = new Date(checkpoint.getTime() + (GRACE_SECONDS + 120) * 1000);

  const decision = decideAccountingOutageAction(checkpoint, lastActivity, now, GRACE_SECONDS);
  assert.deepEqual(decision, {
    type: "credit",
    creditedSeconds: GRACE_SECONDS + 120,
    outageStartedAt: checkpoint
  });
});

test("repeated stale polls continue to point at the same persisted outage start", () => {
  const checkpoint = new Date("2026-08-16T10:00:00Z");
  const lastActivity = checkpoint;
  const firstNow = new Date(checkpoint.getTime() + (GRACE_SECONDS + 60) * 1000);
  const secondNow = new Date(firstNow.getTime() + 30 * 1000);

  const first = decideAccountingOutageAction(checkpoint, lastActivity, firstNow, GRACE_SECONDS);
  const second = decideAccountingOutageAction(checkpoint, lastActivity, secondNow, GRACE_SECONDS);

  assert.equal(first.type, "credit");
  assert.equal(second.type, "credit");
  if (first.type !== "credit" || second.type !== "credit") throw new Error("unreachable");
  assert.equal(first.outageStartedAt.toISOString(), checkpoint.toISOString());
  assert.equal(second.outageStartedAt.toISOString(), checkpoint.toISOString());
});

test("a monthly package keeps only its original balance plus the real outage interval", () => {
  const startsAt = new Date("2026-10-31T18:37:15.986Z");
  const originalExpiry = new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  const outageStart = new Date("2026-11-03T14:09:41.981Z");
  const recovery = new Date("2026-11-04T11:36:54.663Z");
  const frozenBalanceSeconds = (originalExpiry.getTime() - outageStart.getTime()) / 1000;

  const restoredExpiry = expiryFromFrozenBalance(recovery, frozenBalanceSeconds);
  const outageMilliseconds = recovery.getTime() - outageStart.getTime();
  assert.equal(restoredExpiry.getTime(), originalExpiry.getTime() + outageMilliseconds);
});

test("five-minute outage episodes add only their elapsed time, not the frozen monthly balance", () => {
  const startsAt = new Date("2026-10-29T15:38:00.700Z");
  const originalExpiry = new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  let expiry = originalExpiry;
  const intervals = [302, 306, 301, 301, 302];
  let cursor = new Date("2026-11-08T10:59:17.000Z");

  for (const outageSeconds of intervals) {
    const remainingAtPause = (expiry.getTime() - cursor.getTime()) / 1000;
    const recoveredAt = new Date(cursor.getTime() + outageSeconds * 1000);
    expiry = expiryFromFrozenBalance(recoveredAt, remainingAtPause);
    cursor = recoveredAt;
  }

  assert.equal(expiry.getTime(), originalExpiry.getTime() + intervals.reduce((sum, value) => sum + value, 0) * 1000);
});

test("a still-disconnected entitlement stays paused with no reconnect observed", () => {
  const pausedAt = new Date("2026-08-16T10:00:00Z");
  const now = new Date(pausedAt.getTime() + 5 * 60 * 1000);

  const decision = decideResumeAction(pausedAt, null, now, RECONNECT_WINDOW_SECONDS);
  assert.deepEqual(decision, { type: "still-paused" });
});

test("a reconnect inside the window resumes with exactly the time that was frozen", () => {
  const pausedAt = new Date("2026-08-16T10:00:00Z");
  const reconnectedAt = new Date("2026-08-16T10:07:00Z");
  const now = new Date("2026-08-16T10:07:05Z");

  const decision = decideResumeAction(pausedAt, reconnectedAt, now, RECONNECT_WINDOW_SECONDS);
  assert.deepEqual(decision, { type: "resume", creditedSeconds: 7 * 60, reconnectedAt });
});

test("a reconnect after the window closed gets nothing back", () => {
  const pausedAt = new Date("2026-08-16T10:00:00Z");
  const reconnectedAt = new Date(pausedAt.getTime() + (RECONNECT_WINDOW_SECONDS + 3600) * 1000);
  const now = new Date(reconnectedAt.getTime() + 1000);

  const decision = decideResumeAction(pausedAt, reconnectedAt, now, RECONNECT_WINDOW_SECONDS);
  assert.deepEqual(decision, { type: "resume", creditedSeconds: 0, reconnectedAt });
});

test("a customer who never reconnects forfeits the remaining time when the window closes", () => {
  const pausedAt = new Date("2026-08-16T10:00:00Z");
  const now = new Date(pausedAt.getTime() + (RECONNECT_WINDOW_SECONDS + 1) * 1000);

  const decision = decideResumeAction(pausedAt, null, now, RECONNECT_WINDOW_SECONDS);
  assert.deepEqual(decision, { type: "resume", creditedSeconds: 0, reconnectedAt: now });
});
