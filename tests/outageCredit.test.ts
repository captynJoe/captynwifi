import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAccountingOutageAction, decideResumeAction } from "../src/services/outageCredit.js";

const GRACE_SECONDS = 600;
const MAX_CREDIT_SECONDS = 60 * 60 * 24;

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
    outageStartedAt: checkpoint,
    nextCheckpoint: now
  });
});

test("a long-running outage credits again in fresh increments rather than re-crediting the same span", () => {
  const checkpoint = new Date("2026-08-16T10:00:00Z");
  const lastActivity = checkpoint;
  const firstNow = new Date(checkpoint.getTime() + (GRACE_SECONDS + 60) * 1000);

  const first = decideAccountingOutageAction(checkpoint, lastActivity, firstNow, GRACE_SECONDS);
  assert.equal(first.type, "credit");
  if (first.type !== "credit") throw new Error("unreachable");

  // The orchestrator advances the checkpoint to `nextCheckpoint` after crediting.
  const secondNow = new Date(first.nextCheckpoint.getTime() + 30 * 1000);
  const second = decideAccountingOutageAction(first.nextCheckpoint, lastActivity, secondNow, GRACE_SECONDS);
  assert.deepEqual(second, { type: "healthy" });
});

test("a still-disconnected entitlement stays paused with no reconnect observed", () => {
  const pausedAt = new Date("2026-08-16T10:00:00Z");
  const now = new Date(pausedAt.getTime() + 5 * 60 * 1000);

  const decision = decideResumeAction(pausedAt, null, now, MAX_CREDIT_SECONDS);
  assert.deepEqual(decision, { type: "still-paused" });
});

test("a reconnect resumes and credits exactly the personal gap, capped by maxCreditSeconds", () => {
  const pausedAt = new Date("2026-08-16T10:00:00Z");
  const reconnectedAt = new Date("2026-08-16T10:07:00Z");
  const now = new Date("2026-08-16T10:07:05Z");

  const decision = decideResumeAction(pausedAt, reconnectedAt, now, MAX_CREDIT_SECONDS);
  assert.deepEqual(decision, { type: "resume", creditedSeconds: 7 * 60, reconnectedAt });
});

test("a reconnect gap longer than maxCreditSeconds is capped, not fully credited", () => {
  const pausedAt = new Date("2026-08-16T10:00:00Z");
  const reconnectedAt = new Date(pausedAt.getTime() + (MAX_CREDIT_SECONDS + 3600) * 1000);
  const now = new Date(reconnectedAt.getTime() + 1000);

  const decision = decideResumeAction(pausedAt, reconnectedAt, now, MAX_CREDIT_SECONDS);
  assert.deepEqual(decision, { type: "resume", creditedSeconds: MAX_CREDIT_SECONDS, reconnectedAt });
});

test("a customer who never reconnects is force-released after maxCreditSeconds so they don't block expiry forever", () => {
  const pausedAt = new Date("2026-08-16T10:00:00Z");
  const now = new Date(pausedAt.getTime() + (MAX_CREDIT_SECONDS + 1) * 1000);

  const decision = decideResumeAction(pausedAt, null, now, MAX_CREDIT_SECONDS);
  assert.deepEqual(decision, { type: "resume", creditedSeconds: MAX_CREDIT_SECONDS, reconnectedAt: now });
});
