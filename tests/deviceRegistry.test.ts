import assert from "node:assert/strict";
import test from "node:test";
import { diffDevice, type DeviceObservation, type DeviceState } from "../src/services/deviceRegistry.js";

const MAC = "CA:0A:D0:F1:6B:39";
const T0 = new Date("2026-11-24T08:30:00Z");
const T1 = new Date("2026-11-24T08:35:00Z");
const seen = (over: Partial<DeviceObservation> = {}): DeviceObservation => ({ mac: MAC, onNetwork: true, ip: "192.168.88.251", hostName: "Pixel-Fold", dhcpClassId: "android-dhcp-14", ...over });
const ap1 = { apMac: "00-31-92-A5-0A-04", apName: "EAP245", ssid: "CAPTYN", band: "5", rssi: -62 };
const ap3 = { apMac: "3C-78-95-D5-E2-DE", apName: "E2-DE", ssid: "CAPTYN", band: "5", rssi: -55 };

test("a new device is first seen and connected, on its AP", () => {
  const { next, events } = diffDevice(null, seen({ radio: ap1 }), T0);
  assert.deepEqual(events.map((e) => e.type), ["first_seen", "connected", "ap_connected"]);
  assert.equal(next?.apName, "EAP245");
  assert.equal(next?.firstSeenAt, T0);
});

test("nothing changed means no events, only a fresher last-seen and signal", () => {
  const first = diffDevice(null, seen({ radio: ap1 }), T0).next as DeviceState;
  const { next, events } = diffDevice(first, seen({ radio: { ...ap1, rssi: -70 } }), T1);
  assert.deepEqual(events, []);
  assert.equal(next?.lastSeenAt, T1);
  assert.equal(next?.rssi, -70);
});

test("moving to another access point is recorded as a roam, with both ends", () => {
  const first = diffDevice(null, seen({ radio: ap1 }), T0).next as DeviceState;
  const { events } = diffDevice(first, seen({ radio: ap3 }), T1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "roamed");
  assert.equal(events[0].fromValue, "EAP245");
  assert.equal(events[0].toValue, "E2-DE");
});

test("a new IP and a new device name are recorded with old and new values", () => {
  const first = diffDevice(null, seen(), T0).next as DeviceState;
  const { events } = diffDevice(first, seen({ ip: "192.168.88.40", hostName: "Joes-Fold" }), T1);
  assert.deepEqual(events.map((e) => [e.type, e.fromValue, e.toValue]), [
    ["ip_changed", "192.168.88.251", "192.168.88.40"],
    ["name_changed", "Pixel-Fold", "Joes-Fold"]
  ]);
});

test("leaving the network is one disconnect; coming back is a connect", () => {
  const first = diffDevice(null, seen(), T0).next as DeviceState;
  const gone = diffDevice(first, null, T1);
  assert.deepEqual(gone.events.map((e) => e.type), ["disconnected"]);
  assert.equal(diffDevice(gone.next, null, T1).events.length, 0);
  assert.deepEqual(diffDevice(gone.next, seen(), T1).events.map((e) => e.type), ["connected"]);
});

test("when Omada is unavailable, radio facts are kept, not guessed or cleared", () => {
  const first = diffDevice(null, seen({ radio: ap1 }), T0).next as DeviceState;
  const { next, events } = diffDevice(first, seen({ radio: undefined }), T1);
  assert.deepEqual(events, []);
  assert.equal(next?.apName, "EAP245");
});
