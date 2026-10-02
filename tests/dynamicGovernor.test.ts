import assert from "node:assert/strict";
import test from "node:test";
import { WifiDynamicGovernor } from "../src/services/dynamicGovernor.js";

type Sample = { acctUniqueId: string; username: string; inputOctets: bigint; outputOctets: bigint; updatedAt: Date; entitlementId: string | null; rateLimit: string | null; planName: string | null; currentRateLimit: string | null; priceKsh: number; category: string | null };

function sample(updatedAtSec: number, outputOctets: number): Sample {
  return {
    acctUniqueId: "s1",
    username: "u1",
    inputOctets: 0n,
    outputOctets: BigInt(outputOctets),
    updatedAt: new Date(updatedAtSec * 1000),
    entitlementId: null,
    rateLimit: null,
    planName: null,
    currentRateLimit: null,
    priceKsh: 0,
    category: null
  };
}

test("throughput carries the last measured rate between interim updates", () => {
  const governor = new WifiDynamicGovernor() as unknown as {
    calculateThroughput(samples: Sample[]): Array<{ downloadBps: number }>;
  };

  assert.equal(governor.calculateThroughput([sample(0, 0)])[0].downloadBps, 0);
  // Interim update 120s later: 15 MB down = 1 Mbps.
  assert.equal(governor.calculateThroughput([sample(120, 15_000_000)])[0].downloadBps, 1_000_000);
  // Ticks before the next interim update see the same accounting row -- rate holds, not 0.
  assert.equal(governor.calculateThroughput([sample(120, 15_000_000)])[0].downloadBps, 1_000_000);
  assert.equal(governor.calculateThroughput([sample(120, 15_000_000)])[0].downloadBps, 1_000_000);
  // Next update is measured against the last real update, not the last tick.
  assert.equal(governor.calculateThroughput([sample(240, 45_000_000)])[0].downloadBps, 2_000_000);
});
