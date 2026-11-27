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

test("probe also runs hourly in the day, so fair share follows the daytime line", () => {
  assert.equal(ispProbeDue(eat("2026-11-25", "10:05"), eat("2026-11-25", "09:02")), true);
  assert.equal(ispProbeDue(eat("2026-11-25", "10:40"), eat("2026-11-25", "10:05")), false);
  assert.equal(ispProbeDue(eat("2026-11-25", "05:10"), eat("2026-11-25", "03:05")), false, "quiet before 6 am");
});

test("fair-share ceiling is 90% of the measured line, within sane bounds", async () => {
  const { fairShareLimitMbps } = await import("../src/services/ispProbe.js");
  assert.equal(fairShareLimitMbps(22), 20);
  assert.equal(fairShareLimitMbps(70), 63);
  assert.equal(fairShareLimitMbps(3), 8);
  assert.equal(fairShareLimitMbps(200), 90);
});

test("probe runs once per evening half-hour slot and once at 3 am", () => {
  assert.equal(ispProbeDue(eat("2026-11-24", "18:59"), eat("2026-11-24", "18:01")), false, "the 6 pm hourly probe already ran");
  assert.equal(ispProbeDue(eat("2026-11-24", "19:00"), null), true);
  assert.equal(ispProbeDue(eat("2026-11-24", "19:20"), eat("2026-11-24", "19:01")), false);
  assert.equal(ispProbeDue(eat("2026-11-24", "19:31"), eat("2026-11-24", "19:01")), true);
  assert.equal(ispProbeDue(eat("2026-11-24", "23:45"), eat("2026-11-24", "23:01")), true);
  assert.equal(ispProbeDue(eat("2026-11-25", "03:10"), eat("2026-11-24", "23:31")), true);
  assert.equal(ispProbeDue(eat("2026-11-25", "03:20"), eat("2026-11-25", "03:10")), false);
  assert.equal(ispProbeDue(eat("2026-11-25", "02:00"), null), false);
});

test("10 MB in 4 seconds is 20 Mbps", () => {
  assert.equal(mbps(10_000_000, 4), 20);
});
