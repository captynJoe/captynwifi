import assert from "node:assert/strict";
import { test } from "node:test";
import { isSuccessfulStkQuery, formatDarajaMsisdn } from "../src/services/mpesa.js";

test("successful STK query verification requires the matching checkout id", () => {
  assert.equal(isSuccessfulStkQuery({ CheckoutRequestID: "ws_CO_123", ResultCode: 0 }, "ws_CO_123"), true);
  assert.equal(isSuccessfulStkQuery({ CheckoutRequestID: "ws_CO_OTHER", ResultCode: 0 }, "ws_CO_123"), false);
});

test("successful STK query verification rejects non-zero provider results", () => {
  assert.equal(isSuccessfulStkQuery({ CheckoutRequestID: "ws_CO_123", ResultCode: 1032 }, "ws_CO_123"), false);
  assert.equal(isSuccessfulStkQuery({ CheckoutRequestID: "ws_CO_123", ResultCode: "0" }, "ws_CO_123"), true);
});

test("M-PESA phone normalization supports receipt proof matching", () => {
  assert.equal(formatDarajaMsisdn("+254 711 111111"), "254711111111");
  assert.equal(formatDarajaMsisdn("0711111111"), "254711111111");
  assert.equal(formatDarajaMsisdn("123"), null);
});
