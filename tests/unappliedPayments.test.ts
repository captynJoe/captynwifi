import assert from "node:assert/strict";
import test from "node:test";
import { defaultCreditHours, defaultCreditText, describeFailure } from "../src/services/unappliedPayments.js";

test("an add-device payment is worth the time its package still had", () => {
  // 6 HR Pass, paid 11:14, package ran to 17:40 -> about 6.5 h, capped at the plan's 6 h.
  const hours = defaultCreditHours({ purpose: "add_device", paidAt: new Date("2026-11-11T08:14:51Z"), planSeconds: 6 * 3600, targetExpiresAt: new Date("2026-11-11T14:40:48Z") });
  assert.equal(hours, 6);
  const late = defaultCreditHours({ purpose: "add_device", paidAt: new Date("2026-11-11T14:00:00Z"), planSeconds: 6 * 3600, targetExpiresAt: new Date("2026-11-11T14:40:00Z") });
  assert.equal(late, 1, "never less than an hour");
});

test("a new package is worth its full length", () => {
  assert.equal(defaultCreditHours({ purpose: null, paidAt: new Date(), planSeconds: 3 * 3600, targetExpiresAt: null }), 3);
});

test("the message names the day, amount and receipt, and the failure reads plainly", () => {
  const text = defaultCreditText({ amountKsh: 12, paidAt: new Date("2026-11-11T08:14:51Z"), receipt: "UKBKN20342", purpose: "add_device", hours: 6 });
  assert.equal(text.title, "For your 11 Nov payment");
  assert.match(text.message, /KSh 12 on 11 Nov \(M-PESA UKBKN20342\) to add a device/);
  assert.match(text.message, /6h of free WiFi/);
  assert.match(describeFailure("This package has already been upgraded for the current term."), /already been upgraded/);
});
