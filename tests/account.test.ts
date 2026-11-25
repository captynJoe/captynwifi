import assert from "node:assert/strict";
import test from "node:test";
import { codeSignInLocked, generateSmsCode, smsCodeHash, smsSendAllowed } from "../src/services/account.js";

const now = new Date("2026-11-25T10:00:00Z");
const minsAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);

test("SMS codes: 3 per 15 minutes and 8 a day per phone", () => {
  assert.equal(smsSendAllowed([minsAgo(1), minsAgo(2)], now), true);
  assert.equal(smsSendAllowed([minsAgo(1), minsAgo(2), minsAgo(3)], now), false);
  assert.equal(smsSendAllowed([minsAgo(20), minsAgo(21), minsAgo(22)], now), true);
  assert.equal(smsSendAllowed(Array.from({ length: 8 }, (_, i) => minsAgo(30 + i * 60)), now), false);
});

test("device-code sign-in locks after 5 wrong codes; a right one resets the count", () => {
  const wrong = (m: number) => ({ ok: false, at: minsAgo(m) });
  assert.equal(codeSignInLocked([wrong(1), wrong(2), wrong(3), wrong(4)], now), false);
  assert.equal(codeSignInLocked([wrong(1), wrong(2), wrong(3), wrong(4), wrong(5)], now), true);
  assert.equal(codeSignInLocked([wrong(1), wrong(2), { ok: true, at: minsAgo(3) }, wrong(4), wrong(5), wrong(6)], now), false);
  assert.equal(codeSignInLocked([wrong(16), wrong(17), wrong(18), wrong(19), wrong(20)], now), false, "old failures expire");
});

test("SMS codes are 6 digits and stored only as a per-phone hash", () => {
  assert.match(generateSmsCode(), /^\d{6}$/);
  assert.equal(smsCodeHash("254712345678", "123456"), smsCodeHash("254712345678", "123456"));
  assert.notEqual(smsCodeHash("254712345678", "123456"), smsCodeHash("254700000000", "123456"));
});
