import assert from "node:assert/strict";
import { test } from "node:test";
import { TIER_MULTIPLIERS, classifyFamily, scaleBaselinePlan, tierForUtilization } from "../src/services/dynamicPlanEngine.js";

test("tierForUtilization buckets by average utilization score", () => {
  assert.equal(tierForUtilization(0), "QUIET");
  assert.equal(tierForUtilization(0.24), "QUIET");
  assert.equal(tierForUtilization(0.25), "GREEN");
  assert.equal(tierForUtilization(0.49), "GREEN");
  assert.equal(tierForUtilization(0.5), "YELLOW");
  assert.equal(tierForUtilization(0.79), "YELLOW");
  assert.equal(tierForUtilization(0.8), "RED");
  assert.equal(tierForUtilization(0.94), "RED");
  assert.equal(tierForUtilization(0.95), "CRITICAL");
  assert.equal(tierForUtilization(1), "CRITICAL");
});

test("only CRITICAL is withheld from sale", () => {
  for (const [tier, multiplier] of Object.entries(TIER_MULTIPLIERS)) {
    assert.equal(multiplier.published, tier !== "CRITICAL", `${tier} publish flag`);
  }
});

test("congestion tiers trade speed for a higher price, quiet tiers trade the other way", () => {
  assert.ok(TIER_MULTIPLIERS.QUIET.price < TIER_MULTIPLIERS.GREEN.price);
  assert.ok(TIER_MULTIPLIERS.QUIET.rate > TIER_MULTIPLIERS.GREEN.rate);
  assert.ok(TIER_MULTIPLIERS.RED.price > TIER_MULTIPLIERS.GREEN.price);
  assert.ok(TIER_MULTIPLIERS.RED.rate < TIER_MULTIPLIERS.GREEN.rate);
});

const baseline = {
  id: "plan-1",
  name: "Cruise Hour",
  durationSeconds: 3600,
  priceKsh: 10,
  rateLimit: "7M/12M",
  category: "standard",
  deviceLimit: 1
};

test("GREEN tier reproduces the baseline exactly", () => {
  const spec = scaleBaselinePlan(baseline, "GREEN");
  assert.equal(spec.priceKsh, 10);
  assert.equal(spec.durationSeconds, 3600);
  assert.equal(spec.rateLimit, "7M/12M");
  assert.equal(spec.enabled, true);
});

test("QUIET tier: everyday-family plans get a duration bonus only, price and speed stay put", () => {
  // "Cruise Hour" classifies as the everyday family (no gulfstream/highspeed/
  // flash/epl keyword) -- one axis moves per rotation, never all three.
  const spec = scaleBaselinePlan(baseline, "QUIET");
  assert.equal(spec.priceKsh, baseline.priceKsh, "price should stay locked at baseline");
  assert.ok(spec.durationSeconds > baseline.durationSeconds, "duration should get the bonus");
  assert.equal(spec.rateLimit, baseline.rateLimit, "speed should stay locked at baseline");
});

test("CRITICAL tier is unpublished regardless of the scaled numbers", () => {
  const spec = scaleBaselinePlan(baseline, "CRITICAL");
  assert.equal(spec.enabled, false);
});

test("day-plus baselines keep a fixed duration regardless of tier", () => {
  const monthly = { ...baseline, name: "Monthly Standard", durationSeconds: 2592000, priceKsh: 600, rateLimit: "8M/12M" };
  for (const tier of ["QUIET", "GREEN", "YELLOW", "RED"] as const) {
    const spec = scaleBaselinePlan(monthly, tier);
    assert.equal(spec.durationSeconds, 2592000, `${tier} duration should stay fixed at 30 days`);
  }
});

test("monthly-scale plans get nearly-fixed pricing, not the full hourly discount/surge", () => {
  // Idle bandwidth tonight doesn't mean the network will still be quiet
  // when a 30-day customer is still using their plan next week -- monthly
  // commitments shouldn't be discounted (or surge-priced) like a walk-up
  // hourly purchase would be.
  const monthly = { ...baseline, name: "Cruise Month", durationSeconds: 2592000, priceKsh: 500, rateLimit: "5M/7M" };
  assert.equal(scaleBaselinePlan(monthly, "QUIET").priceKsh, 500);
  assert.equal(scaleBaselinePlan(monthly, "RED").priceKsh, 500);
  // Speed still gets a small perk/penalty -- "nearly fixed", not literally frozen.
  assert.ok(scaleBaselinePlan(monthly, "QUIET").rateLimit !== "5M/7M");
});

test("weekly plans get a small discount, not the full hourly-tier swing", () => {
  const weekly = { ...baseline, name: "Cruise Weekly", durationSeconds: 604800, priceKsh: 250, rateLimit: "7M/12M" };
  const quietPrice = scaleBaselinePlan(weekly, "QUIET").priceKsh;
  assert.ok(quietPrice < 250, "should still get some discount");
  assert.ok(quietPrice >= 225, "but nowhere near the full ~30% hourly-tier discount (would be 175)");
});

test("multi-day plans get a milder swing than hourly plans, scaled proportionally by commitment length", () => {
  const weekend = { ...baseline, name: "Highspeed Weekend", durationSeconds: 259200, priceKsh: 120, rateLimit: "8M/15M" };
  // Flash is the family whose primary axis is price at FULL bucket, so this
  // is a fair "what would the full hourly discount look like" comparison
  // (an everyday-family hourly plan doesn't flex price under QUIET at all
  // anymore -- it flexes duration instead, see the dedicated test above).
  const hourly = { ...baseline, name: "Flash", durationSeconds: 3600, priceKsh: 120, rateLimit: "8M/15M" };
  const weekendDiscount = 120 - scaleBaselinePlan(weekend, "QUIET").priceKsh;
  const hourlyDiscount = 120 - scaleBaselinePlan(hourly, "QUIET").priceKsh;
  assert.ok(weekendDiscount > 0 && weekendDiscount < hourlyDiscount, "milder than the full hourly discount, but not zero");
});

test("walk-up (<=8h) plans still get the full existing dynamic swing, unchanged", () => {
  const flash = { ...baseline, name: "Flash", durationSeconds: 1800, priceKsh: 5, rateLimit: "6M/6M" };
  assert.equal(scaleBaselinePlan(flash, "QUIET").priceKsh, 4);
});

test("classifyFamily infers from the plan name", () => {
  assert.equal(classifyFamily("Gulfstream 3 HR"), "gulfstream");
  assert.equal(classifyFamily("Highspeed 6 HR"), "fast");
  assert.equal(classifyFamily("EPL HD 2 HR"), "occasion");
  assert.equal(classifyFamily("Flash"), "flash");
  assert.equal(classifyFamily("Cruise Hour"), "everyday");
  assert.equal(classifyFamily("8 Balls"), "everyday");
});

test("Flash: price is the only axis that moves -- duration stays fixed, speed only nudges", () => {
  // Baseline rate needs to be large enough that a ~6% nudge survives
  // rounding to the nearest whole Mbps (a 6M/6M baseline rounds right back
  // to itself, which isn't evidence the nudge didn't happen -- it's just
  // too small a number to show at that scale).
  const flash = { ...baseline, name: "Flash", durationSeconds: 1800, priceKsh: 5, rateLimit: "20M/20M" };
  const spec = scaleBaselinePlan(flash, "QUIET");
  assert.equal(spec.priceKsh, 4);
  assert.equal(spec.durationSeconds, flash.durationSeconds, "duration is locked for flash");
  assert.notEqual(spec.rateLimit, flash.rateLimit, "speed gets a small secondary nudge");
});

test("everyday family never moves more than one axis per rotation", () => {
  const threeHrGo = { ...baseline, name: "3 HR Go", durationSeconds: 10800, priceKsh: 10, rateLimit: "5M/3M" };
  const quiet = scaleBaselinePlan(threeHrGo, "QUIET");
  assert.equal(quiet.priceKsh, 10, "QUIET: price locked");
  assert.equal(quiet.rateLimit, "5M/3M", "QUIET: speed locked");
  assert.ok(quiet.durationSeconds > 10800, "QUIET: duration is the active axis");

  const red = scaleBaselinePlan(threeHrGo, "RED");
  assert.equal(red.durationSeconds, 10800, "RED: duration locked");
  assert.equal(red.rateLimit, "5M/3M", "RED: speed locked");
  assert.ok(red.priceKsh > 10, "RED: price is the active axis");
});

test("Gulfstream: price and duration are frozen, speed swings harder than a normal plan's", () => {
  const gulfstream = { ...baseline, name: "Gulfstream 3 HR", durationSeconds: 10800, priceKsh: 30, rateLimit: "21M/15M" };
  const everyday = { ...baseline, name: "Cruise 3 HR", durationSeconds: 10800, priceKsh: 30, rateLimit: "21M/15M" };

  const quietGulf = scaleBaselinePlan(gulfstream, "QUIET");
  assert.equal(quietGulf.priceKsh, 30, "price frozen");
  assert.equal(quietGulf.durationSeconds, 10800, "duration frozen");

  const gulfDownload = parseInt(quietGulf.rateLimit.split("/")[1], 10);
  const everydayDownload = parseInt(scaleBaselinePlan(everyday, "QUIET").rateLimit?.split("/")[1] ?? "0", 10);
  // everyday's speed axis is locked (0 intensity), so its baseline speed
  // passes through unchanged -- Gulfstream's amplified swing should exceed it.
  assert.ok(gulfDownload > everydayDownload, "Gulfstream's speed swing should exceed a plan whose speed axis is locked");
});

test("sub-day baselines still flex duration as before", () => {
  const spec = scaleBaselinePlan(baseline, "QUIET");
  assert.notEqual(spec.durationSeconds, baseline.durationSeconds);
});

test("price never scales to zero or below, even for a very cheap baseline", () => {
  // Flash is the family whose price axis actually moves under QUIET.
  const cheap = { ...baseline, name: "Flash", priceKsh: 1 };
  const spec = scaleBaselinePlan(cheap, "QUIET");
  assert.ok(spec.priceKsh >= 1);
});

test("duration never scales below the 5 minute floor", () => {
  const short = { ...baseline, durationSeconds: 600 };
  const spec = scaleBaselinePlan(short, "RED");
  assert.ok(spec.durationSeconds >= 300);
});

test("name, category, and device limit pass through unscaled", () => {
  const spec = scaleBaselinePlan(baseline, "RED");
  assert.equal(spec.name, baseline.name);
  assert.equal(spec.category, baseline.category);
  assert.equal(spec.deviceLimit, baseline.deviceLimit);
});
