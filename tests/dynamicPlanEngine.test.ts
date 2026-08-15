import assert from "node:assert/strict";
import { test } from "node:test";
import { TIER_SPECS, tierForUtilization } from "../src/services/dynamicPlanEngine.js";

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
  for (const [tier, spec] of Object.entries(TIER_SPECS)) {
    assert.equal(spec.published, tier !== "CRITICAL", `${tier} publish flag`);
  }
});

test("congestion tiers trade speed and duration for a higher price", () => {
  assert.ok(TIER_SPECS.QUIET.priceKsh < TIER_SPECS.GREEN.priceKsh);
  assert.ok(TIER_SPECS.RED.priceKsh > TIER_SPECS.GREEN.priceKsh);
  assert.ok(TIER_SPECS.RED.durationSeconds < TIER_SPECS.GREEN.durationSeconds);
  assert.ok(TIER_SPECS.QUIET.durationSeconds > TIER_SPECS.GREEN.durationSeconds);
});
