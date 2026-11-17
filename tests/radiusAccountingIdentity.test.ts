import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const entrypoint = readFileSync(new URL("../freeradius/entrypoint.sh", import.meta.url), "utf8");

type AccountingPacket = {
  userName: string;
  sessionId: string;
  nasIp: string;
  nasPort: string;
  nasPortType: string;
  callingStationId: string;
  calledStationId: string;
  eventTimestamp: number;
  sessionTime: number;
};

function accountingSessionId(packet: AccountingPacket) {
  const sessionStartedAt = packet.eventTimestamp - packet.sessionTime;
  const key = [
    packet.userName,
    packet.sessionId,
    packet.nasIp,
    packet.nasPort,
    packet.nasPortType,
    packet.callingStationId,
    packet.calledStationId,
    String(sessionStartedAt)
  ].join("|");
  return createHash("md5").update(key).digest("hex");
}

const basePacket: AccountingPacket = {
  userName: "ppp-user",
  sessionId: "81f00011",
  nasIp: "10.8.0.50",
  nasPort: "pppoe-ether5",
  nasPortType: "Virtual",
  callingStationId: "AA:BB:CC:DD:EE:FF",
  calledStationId: "captyn",
  eventTimestamp: 1_000,
  sessionTime: 0
};

test("FreeRADIUS accounting identity is stable across Start, Interim-Update, and Stop", () => {
  assert.match(entrypoint, /captyn_session_identity/);
  assert.match(entrypoint, /&Acct-Unique-Session-Id := .*%\{md5:/);
  assert.match(entrypoint, /%\{integer:Event-Timestamp\} - %\{%\{Acct-Session-Time\}:-0\}/);

  const start = accountingSessionId(basePacket);
  const interim = accountingSessionId({ ...basePacket, eventTimestamp: 1_120, sessionTime: 120 });
  const stop = accountingSessionId({ ...basePacket, eventTimestamp: 1_600, sessionTime: 600 });

  assert.equal(interim, start);
  assert.equal(stop, start);
});

test("a later PPP session gets a new identity when RouterOS reuses its session ID", () => {
  const previous = accountingSessionId(basePacket);
  const reconnected = accountingSessionId({ ...basePacket, eventTimestamp: 2_000, sessionTime: 0 });

  assert.notEqual(reconnected, previous);
});
