import assert from "node:assert/strict";
import test from "node:test";
import { packageEndedMessage } from "../src/services/packageEnded.js";

test("an ended package is named, with its end time in Nairobi time", () => {
  const ended = new Date("2026-11-16T12:44:00Z"); // 3:44 pm EAT
  assert.equal(packageEndedMessage("6 HR Pass", ended, new Date("2026-11-16T17:20:00Z")), "Your 6 HR Pass ended at 3:44 pm today. Choose a package to get back online.");
  assert.equal(packageEndedMessage("6 HR Pass", ended, new Date("2026-11-17T06:00:00Z")), "Your 6 HR Pass ended at 3:44 pm on 16 Nov. Choose a package to get back online.");
  assert.match(packageEndedMessage(null, new Date("2026-11-16T21:05:00Z"), new Date("2026-11-17T09:00:00Z")), /^Your package ended at 12:05 am today/);
});
