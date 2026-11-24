import assert from "node:assert/strict";
import test from "node:test";
import { promoGateResult } from "../src/services/housingStanding.js";

const VI = "Village Inn";

test("a tenant in good standing gets the promo", () => {
  assert.deepEqual(promoGateResult(VI, "254712345678", { eligible: true, reason: "good_standing", houseNumber: "12" }), { allowed: true, houseNumber: "12" });
});

test("no confirmed M-PESA phone means no link to a house, and says how to make one", () => {
  const gate = promoGateResult(VI, null, null);
  assert.equal(gate.allowed, false);
  assert.equal(gate.allowed === false && gate.code, "no_phone");
});

test("overdue rent and overdue utilities name the house, never an amount", () => {
  const rent = promoGateResult(VI, "254712345678", { eligible: false, reason: "rent_overdue", houseNumber: "7" });
  assert.ok(rent.allowed === false && rent.message.includes("House 7") && !/ksh|\d{3,}/i.test(rent.message));
  const utilities = promoGateResult(VI, "254712345678", { eligible: false, reason: "utilities_overdue", houseNumber: "7" });
  assert.equal(utilities.allowed === false && utilities.code, "utilities_overdue");
});

test("Housing unreachable is said plainly, not treated as a refusal or a pass", () => {
  const gate = promoGateResult(VI, "254712345678", null, true);
  assert.equal(gate.allowed === false && gate.code, "housing_unavailable");
});
