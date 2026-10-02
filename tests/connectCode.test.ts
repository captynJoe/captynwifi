import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECT_CODE_LENGTH, generateConnectCode, normalizeConnectCode } from "../src/services/connectCode.js";

test("generated connect codes are 6 unambiguous characters", () => {
  for (let i = 0; i < 500; i += 1) {
    const code = generateConnectCode();
    assert.equal(code.length, CONNECT_CODE_LENGTH);
    assert.match(code, /^[A-HJKMNP-Z2-9]+$/);
    assert.equal(normalizeConnectCode(code), code);
  }
});

test("normalizeConnectCode accepts typed variations and rejects vouchers", () => {
  assert.equal(normalizeConnectCode("k7p 2qx"), "K7P2QX");
  assert.equal(normalizeConnectCode("K7P-2QX"), "K7P2QX");
  assert.equal(normalizeConnectCode("7QK4M9PX"), null); // 8-char voucher
  assert.equal(normalizeConnectCode("K0P2QX"), null); // 0 is never issued
});
