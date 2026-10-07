import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMikrotikRateLimit, rateLimitEquals, withBurst } from "../src/services/rateLimit.js";

test("burst doubles the speed, triggers under 3/4 of it, over 20s", () => {
  assert.equal(withBurst("6M/8M"), "6M/8M 12M/16M 4500k/6M 20/20");
  assert.equal(withBurst("2M/6M"), "2M/6M 4M/12M 1500k/4500k 20/20");
  assert.equal(withBurst("7M/12M"), "7M/12M 14M/24M 5250k/9M 20/20");
});

test("unparseable or empty rates pass through untouched", () => {
  assert.equal(withBurst(null), null);
  assert.equal(withBurst("weird"), "weird");
});

test("a burst rate parses and compares by its base speed", () => {
  assert.deepEqual(parseMikrotikRateLimit("6M/8M 12M/16M 4500k/6M 20/20"), { uploadBps: 6_000_000, downloadBps: 8_000_000 });
  // The governor disconnects a device when these differ -- existing plain
  // sessions must not look different from a burst target of the same speed.
  assert.equal(rateLimitEquals("6M/8M", "6M/8M 12M/16M 4500k/6M 20/20"), true);
  assert.equal(rateLimitEquals("6M/8M", "4M/6M 8M/12M 3M/4500k 20/20"), false);
});
