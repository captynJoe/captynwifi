import assert from "node:assert/strict";
import test from "node:test";
import { ispCapAlert, planAlertChanges } from "../src/services/intelAlerts.js";
import { ispProbeDue, mbps } from "../src/services/ispProbe.js";

// EAT is UTC+3: 20:00 EAT = 17:00Z.
const eat = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+03:00`);

test("alerts open once, stay open while seen, resolve when gone", () => {
  const seen = [{ key: "a", rule: "r", subject: "s", title: "t" }, { key: "b", rule: "r", subject: "s", title: "t" }];
  const plan = planAlertChanges([{ id: "1", key: "a" }, { id: "2", key: "c" }], seen);
  assert.deepEqual(plan.create.map((a) => a.key), ["b"]);
  assert.deepEqual(plan.refresh.map((a) => a.id), ["1"]);
  assert.deepEqual(plan.resolve.map((a) => a.id), ["2"]);
});

test("ISP cap alert needs three slow evening readings against the 3 am baseline", () => {
  const baseline = { at: eat("2026-11-24", "03:05"), totalMbps: 70 };
  const slow = ["20:00", "20:30", "21:00"].map((t) => ({ at: eat("2026-11-24", t), totalMbps: 22 }));
  const now = eat("2026-11-24", "21:10");
  assert.equal(ispCapAlert([baseline, ...slow.slice(0, 2)], now), null);
  const alert = ispCapAlert([baseline, ...slow], now);
  assert.equal(alert?.key, "isp_cap:2026-11-24");
  assert.equal(ispCapAlert(slow, now), null, "no baseline, no alert");
  assert.equal(ispCapAlert([baseline, ...slow.map((p) => ({ ...p, totalMbps: 40 }))], now), null);
});

test("probe runs every 30 minutes, day and night, once per slot", () => {
  assert.equal(ispProbeDue(eat("2026-11-25", "00:31"), eat("2026-11-25", "00:02")), true, "after midnight, when the cap lifts");
  assert.equal(ispProbeDue(eat("2026-11-25", "00:50"), eat("2026-11-25", "00:31")), false);
  assert.equal(ispProbeDue(eat("2026-11-25", "10:05"), eat("2026-11-25", "09:31")), true);
  assert.equal(ispProbeDue(eat("2026-11-25", "10:20"), eat("2026-11-25", "10:05")), false);
});

test("fair-share ceiling is 90% of the measured line, within sane bounds", async () => {
  const { fairShareLimitMbps } = await import("../src/services/ispProbe.js");
  assert.equal(fairShareLimitMbps(22), 20);
  assert.equal(fairShareLimitMbps(70), 63);
  assert.equal(fairShareLimitMbps(3), 15, "never below 15");
  assert.equal(fairShareLimitMbps(200), 180, "two ISPs together aren't capped at 90 any more");
});

test("the limit rises at once but only falls after two low tests in a row", async () => {
  const { decideFairShareLimit } = await import("../src/services/ispProbe.js");
  assert.equal(decideFairShareLimit(26, 59, null), 59, "rises immediately");
  assert.equal(decideFairShareLimit(59, 20, null), 59, "one low reading is held");
  assert.equal(decideFairShareLimit(59, 20, 59), 59, "previous test disagreed: held");
  assert.equal(decideFairShareLimit(59, 20, 22), 22, "two low readings: lowers, to the higher of the two");
  assert.equal(decideFairShareLimit(null, 30, null), 30);
});

test("an evening slot runs once, and the first probe runs straight away", () => {
  assert.equal(ispProbeDue(eat("2026-11-24", "19:00"), null), true);
  assert.equal(ispProbeDue(eat("2026-11-24", "19:20"), eat("2026-11-24", "19:01")), false);
  assert.equal(ispProbeDue(eat("2026-11-24", "19:31"), eat("2026-11-24", "19:01")), true);
});

test("10 MB in 4 seconds is 20 Mbps", () => {
  assert.equal(mbps(10_000_000, 4), 20);
});

test("'how busy' is judged against the measured line, not a fixed 80 Mbps", async () => {
  const { lineCapacityMbps } = await import("../src/services/ispProbe.js");
  const now = new Date("2026-11-27T19:00:00Z");
  assert.equal(lineCapacityMbps({ at: new Date("2026-11-27T18:40:00Z"), totalMbps: 22 }, 80, now), 22);
  assert.equal(lineCapacityMbps({ at: new Date("2026-11-27T17:00:00Z"), totalMbps: 22 }, 80, now), 80, "stale reading: fall back");
  assert.equal(lineCapacityMbps(null, 80, now), 80);
});
