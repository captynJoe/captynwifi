import assert from "node:assert/strict";
import test from "node:test";
import { classifyTraceQuery, maskPhone } from "../src/services/clientTrace.js";

test("recognises each kind of search term", () => {
  assert.deepEqual(classifyTraceQuery("ca:0a:d0:f1:6b:39"), { kind: "mac", value: "CA:0A:D0:F1:6B:39" });
  assert.deepEqual(classifyTraceQuery("192.168.88.251"), { kind: "ip", value: "192.168.88.251" });
  assert.deepEqual(classifyTraceQuery("0712 345 678"), { kind: "phone", value: "254712345678" });
  assert.deepEqual(classifyTraceQuery("+254712345678"), { kind: "phone", value: "254712345678" });
  assert.deepEqual(classifyTraceQuery("UKH1G2LCOF"), { kind: "receipt", value: "UKH1G2LCOF" });
  assert.deepEqual(classifyTraceQuery("CG-JETSTREAM-MIKE-PKCV"), { kind: "username", value: "CG-JETSTREAM-MIKE-PKCV" });
  assert.deepEqual(classifyTraceQuery("Galaxy-A-16"), { kind: "hostname", value: "Galaxy-A-16" });
});

test("phone numbers are masked by default", () => {
  assert.equal(maskPhone("254712345678"), "2547••••678");
  assert.equal(maskPhone(null), null);
});
