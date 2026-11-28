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

test("internet lines are read from config, with today's single line as the default", async () => {
  const { readWanLines } = await import("../src/config.js");
  assert.deepEqual(readWanLines("ether1||Mymanga"), [{ iface: "ether1", table: null, label: "Mymanga" }]);
  assert.deepEqual(readWanLines("ether1|to-isp1|Mymanga, ether3|to-isp2|Safaricom").map((l) => [l.iface, l.table, l.label]), [["ether1", "to-isp1", "Mymanga"], ["ether3", "to-isp2", "Safaricom"]]);
  assert.deepEqual(readWanLines("bad port|x|y"), [{ iface: "ether1", table: null, label: "ISP1" }], "nonsense falls back safely");
});

test("data used per line counts across router restarts (counter drops to zero)", async () => {
  const { counterUsageBytes } = await import("../src/services/ispProbe.js");
  assert.equal(counterUsageBytes([100, 300, 600]), 500);
  assert.equal(counterUsageBytes([100, 300, 50, 150]), 200 + 50 + 100, "after a reboot it counts from zero");
  assert.equal(counterUsageBytes([42]), 0);
});

test("router ping times are read in milliseconds", async () => {
  const { parseRouterDurationMs } = await import("../src/services/routeros.js");
  assert.equal(parseRouterDurationMs("1ms846us"), 1.846);
  assert.equal(parseRouterDurationMs("23ms"), 23);
  assert.equal(parseRouterDurationMs("1s20ms"), 1020);
  assert.equal(parseRouterDurationMs(undefined), null);
});

test("fair queue guard: a full queue on a quiet line is raised at once", async () => {
  const { guardDecision } = await import("../src/services/ispProbe.js");
  const bounds = { maxMbps: 100, minMbps: 15 };
  // Last night: queue at 26 and full, router ping 2 ms -> the ISP had room.
  const raise = guardDecision({ limitMbps: 26, rateMbps: 26, queuedBytes: 200000, pingMs: 2 }, { baselineMs: 2, recentPings: [2], highPingRun: 0 }, bounds);
  assert.equal(raise.limit, 31);
  // Already at the port's speed: nothing more to give.
  assert.equal(guardDecision({ limitMbps: 100, rateMbps: 99, queuedBytes: 1, pingMs: 2 }, { baselineMs: 2, recentPings: [2], highPingRun: 0 }, bounds).limit, null);
});

test("fair queue guard: settles under a full ISP line only after three high-ping looks", async () => {
  const { guardDecision } = await import("../src/services/ispProbe.js");
  const bounds = { maxMbps: 100, minMbps: 15 };
  const busy = { limitMbps: 60, rateMbps: 24, queuedBytes: 0, pingMs: 80 };
  assert.equal(guardDecision(busy, { baselineMs: 2, recentPings: [], highPingRun: 2 }, bounds).limit, null, "rate far below limit: not our concern");
  const capped = { limitMbps: 26, rateMbps: 25, queuedBytes: 0, pingMs: 80 };
  assert.equal(guardDecision(capped, { baselineMs: 2, recentPings: [], highPingRun: 2 }, bounds).limit, null, "two high looks: wait");
  assert.equal(guardDecision(capped, { baselineMs: 2, recentPings: [], highPingRun: 3 }, bounds).limit, 23, "three: settle just under what flows");
  assert.equal(guardDecision({ ...capped, rateMbps: 10, limitMbps: 12 }, { baselineMs: 2, recentPings: [], highPingRun: 3 }, bounds).limit, null, "never below the floor");
});

test("fair queue guard: after settling under a full line it waits 10 minutes before raising", async () => {
  const { guardDecision } = await import("../src/services/ispProbe.js");
  const full = { limitMbps: 22, rateMbps: 22, queuedBytes: 5000, pingMs: 2 };
  const now = Date.parse("2026-11-28T18:00:00Z");
  assert.equal(guardDecision(full, { baselineMs: 2, recentPings: [], highPingRun: 0, lastLowerAt: now - 5 * 60 * 1000 }, { maxMbps: 100, minMbps: 15 }, now).limit, null);
  assert.equal(guardDecision(full, { baselineMs: 2, recentPings: [], highPingRun: 0, lastLowerAt: now - 11 * 60 * 1000 }, { maxMbps: 100, minMbps: 15 }, now).limit, 27);
});
