import assert from "node:assert/strict";
import { test } from "node:test";
import { TIER_MULTIPLIERS, scaleBaselinePlan, tierForUtilization } from "../src/services/dynamicPlanEngine.js";

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

test("QUIET tier is cheaper, faster, and longer than the baseline", () => {
  const spec = scaleBaselinePlan(baseline, "QUIET");
  assert.ok(spec.priceKsh < baseline.priceKsh);
  assert.ok(spec.durationSeconds > baseline.durationSeconds);
  const [upload, download] = spec.rateLimit.split("/").map((part) => parseInt(part, 10));
  assert.ok(upload > 7 && download > 12);
});

test("CRITICAL tier is unpublished regardless of the scaled numbers", () => {
  const spec = scaleBaselinePlan(baseline, "CRITICAL");
  assert.equal(spec.enabled, false);
});

test("price never scales to zero or below, even for a very cheap baseline", () => {
  const cheap = { ...baseline, priceKsh: 1 };
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
