import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIERS, climbGap, isNairobiSunday, nairobiMonthStart, nairobiWeekStart, normalizeTiers, pickReleaseAt, pickWindow, rankRegulars, tierForRank } from "../src/services/loyalty.js";
import { boostRateLimit, fasterRateLimit } from "../src/services/rateLimit.js";

// Sunday 2026-10-11 10:00 Nairobi = 07:00 UTC.
const sunday = new Date("2026-10-11T07:00:00Z");
const daysAgo = (days: number, hourUtc = 9) => new Date(Date.UTC(2026, 9, 11 - days, hourUtc));

test("weeks start at Sunday midnight Nairobi time", () => {
  assert.equal(nairobiWeekStart(sunday).toISOString(), "2026-10-10T21:00:00.000Z");
  // Saturday 23:30 Nairobi is still the previous week.
  assert.equal(nairobiWeekStart(new Date("2026-10-10T20:30:00Z")).toISOString(), "2026-10-03T21:00:00.000Z");
  assert.equal(isNairobiSunday(sunday), true);
  assert.equal(isNairobiSunday(new Date("2026-10-10T20:30:00Z")), false);
  assert.equal(isNairobiSunday(new Date("2026-10-10T21:30:00Z")), true);
});

test("points weigh spend 70, regularity 30; one big purchase alone doesn't qualify", () => {
  const payments = [
    // KSh 12 a day for the last 8 days: 96.
    ...Array.from({ length: 8 }, (_, day) => ({ phone: "254700000001", amountKsh: 12, createdAt: daysAgo(day), deviceMac: "AA:AA:AA:AA:AA:01" })),
    // One month pass, then nothing.
    { phone: "254700000002", amountKsh: 500, createdAt: daysAgo(3), deviceMac: null },
    // KSh 25 on 6 days: 150, the top spender among regulars.
    ...Array.from({ length: 6 }, (_, day) => ({ phone: "254700000003", amountKsh: 25, createdAt: daysAgo(day * 2), deviceMac: null })),
    // Also 96 over 8 days, but three to four weeks ago: loses the tie.
    ...Array.from({ length: 8 }, (_, day) => ({ phone: "254700000004", amountKsh: 12, createdAt: daysAgo(20 + day), deviceMac: null })),
    // Two payments on one day are one paid day; free claims don't count.
    { phone: "254700000005", amountKsh: 10, createdAt: daysAgo(1, 8), deviceMac: null },
    { phone: "254700000005", amountKsh: 10, createdAt: daysAgo(1, 10), deviceMac: null },
    { phone: "254700000005", amountKsh: 0, createdAt: daysAgo(2), deviceMac: null }
  ];
  const ranked = rankRegulars(payments, sunday, { minPaidDays: 5 });
  assert.deepEqual(ranked.map((winner) => winner.phone), ["254700000003", "254700000001", "254700000004"]);
  assert.equal(ranked[0].spentKsh, 150);
  // Top spender: 70 + 30 x (regularity vs the most regular).
  assert.ok(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score);
  assert.equal(ranked[1].score, Math.round(70 * 96 / 150 + 30));
  assert.equal(ranked[1].paidDays, 8);
  assert.equal(ranked[1].deviceMac, "AA:AA:AA:AA:AA:01");

  const everyone = rankRegulars(payments, sunday, { minPaidDays: 1 });
  assert.equal(everyone.find((winner) => winner.phone === "254700000005")?.paidDays, 1);
  assert.equal(everyone.find((winner) => winner.phone === "254700000005")?.spentKsh, 20);
  assert.equal(rankRegulars(payments, sunday, { minPaidDays: 5 })[0].phone, "254700000003");
});

test("release lands on a daytime moment Monday to Saturday, never in the past", () => {
  const weekStart = nairobiWeekStart(sunday);
  for (const value of [0, 0.25, 0.5, 0.999]) {
    const at = pickReleaseAt(weekStart, sunday, () => value);
    const local = new Date(at.getTime() + 3 * 3600 * 1000);
    assert.ok(local.getUTCDay() >= 1 && local.getUTCDay() <= 6, at.toISOString());
    assert.ok(local.getUTCHours() >= 8 && local.getUTCHours() < 20, at.toISOString());
  }
  // Picked on Friday 15:00: only Friday's remaining window or Saturday.
  const friday = new Date("2026-10-16T12:00:00Z");
  for (const value of [0, 0.999]) assert.ok(pickReleaseAt(weekStart, friday, () => value) >= friday);
  // After Saturday 20:00 there's no window left this week: release now.
  const late = new Date("2026-10-17T18:00:00Z");
  assert.equal(pickReleaseAt(weekStart, late).getTime(), late.getTime());
});

test("points reset monthly; the first week of a month rewards last month", () => {
  assert.equal(nairobiMonthStart(sunday).toISOString(), "2026-09-30T21:00:00.000Z");
  // 11 Oct: this month so far.
  assert.equal(pickWindow(sunday).month, "2026-10");
  // Sunday 4 Oct: September's final ranking.
  const early = pickWindow(new Date("2026-10-04T07:00:00Z"));
  assert.equal(early.month, "2026-09");
  assert.equal(early.from.toISOString(), "2026-08-31T21:00:00.000Z");
  assert.equal(early.to.toISOString(), "2026-09-30T21:00:00.000Z");
});

test("tiers by rank, best first; bad admin input falls back to defaults", () => {
  const tiers = normalizeTiers([{ name: "Bronze", maxRank: 30, freeHours: 3 }, { name: "Gold", maxRank: 5, freeHours: 12, speedBoostPct: 50 }]);
  assert.deepEqual(tiers.map((tier) => tier.name), ["Gold", "Bronze"]);
  assert.equal(tierForRank(tiers, 1)?.name, "Gold");
  assert.equal(tierForRank(tiers, 6)?.name, "Bronze");
  assert.equal(tierForRank(tiers, 31), null);
  assert.deepEqual(normalizeTiers("nonsense"), DEFAULT_TIERS);
  assert.deepEqual(normalizeTiers([{ name: "", maxRank: 0 }]), DEFAULT_TIERS);
});

test("climb gap: points to pass the next person and roughly what that costs", () => {
  const ranked = [
    { phone: "a", deviceMac: null, paidDays: 20, spentKsh: 1000, score: 95 },
    { phone: "b", deviceMac: null, paidDays: 20, spentKsh: 800, score: 80 },
    { phone: "c", deviceMac: null, paidDays: 10, spentKsh: 400, score: 50 }
  ];
  assert.deepEqual(climbGap(ranked, 2, 1), { points: 31, ksh: Math.ceil((31 * 1000) / 70) });
  // The top spender can't climb on spend alone.
  assert.deepEqual(climbGap(ranked, 0, -1), null);
  assert.equal(climbGap([{ ...ranked[0], score: 60 }, { ...ranked[0], phone: "z", score: 70 }], 0, 0), null);
});

test("speed boost raises base speeds; a boost never slows a package", () => {
  assert.equal(boostRateLimit("4M/8M", 50), "6M/12M");
  assert.equal(boostRateLimit("4M/8M", 0), "4M/8M");
  assert.equal(fasterRateLimit("8M/20M", "6M/12M"), "8M/20M");
  assert.equal(fasterRateLimit("4M/8M", "6M/12M"), "6M/12M");
});

