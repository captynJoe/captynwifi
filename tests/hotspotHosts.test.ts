import assert from "node:assert/strict";
import test from "node:test";
import { realHostRows, waitingHostRows } from "../src/services/routeros.js";

const lease = (mac: string, address: string) => [mac, { "mac-address": mac, address }] as [string, Record<string, string>];
const leases = new Map([lease("AA:AA:AA:AA:AA:01", "192.168.88.13"), lease("AA:AA:AA:AA:AA:02", "192.168.88.40")]);
const host = (mac: string, address: string, authorized: boolean) => ({ "mac-address": mac, address, authorized: String(authorized), bypassed: "false" });

test("a ghost entry on another network's address is not a waiting device", () => {
  const hosts = [host("AA:AA:AA:AA:AA:01", "192.168.88.13", true), host("AA:AA:AA:AA:AA:01", "10.226.246.249", false)];
  assert.deepEqual(waitingHostRows(hosts, leases), []);
});

test("a ghost alone (real entry gone) still isn't signed in on a foreign address", () => {
  assert.deepEqual(waitingHostRows([host("AA:AA:AA:AA:AA:01", "10.226.246.249", false)], leases), []);
});

test("a device really waiting on its lease address is picked up", () => {
  const rows = waitingHostRows([host("AA:AA:AA:AA:AA:02", "192.168.88.40", false)], leases);
  assert.equal(rows.length, 1);
});

test("the device collector keeps the real entry, so ghosts don't look like IP changes", () => {
  const rows = realHostRows([host("AA:AA:AA:AA:AA:01", "10.226.246.249", false), host("AA:AA:AA:AA:AA:01", "192.168.88.13", true)], leases);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, "192.168.88.13");
});
