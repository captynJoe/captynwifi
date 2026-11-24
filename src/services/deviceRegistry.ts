// Client Intelligence, Phase 2: turn periodic snapshots (router hotspot
// hosts + DHCP leases, Omada clients) into a persistent device record and a
// change log. Only changes become events -- first seen, connect/disconnect,
// new IP, new device name, roaming between access points, band changes --
// so a device's whole history is a short, readable timeline.
//
// Sources stay separate and honest: the router decides whether a device is on
// the network; Omada only adds radio facts (AP, SSID, band, signal). When
// Omada can't be reached its facts are left as they were, never guessed.

export type DeviceState = {
  mac: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  online: boolean;
  ip: string | null;
  hostName: string | null;
  dhcpClassId: string | null;
  apMac: string | null;
  apName: string | null;
  ssid: string | null;
  band: string | null;
  rssi: number | null;
  signalAt: Date | null;
};

export type RadioObservation = { apMac: string; apName: string | null; ssid: string | null; band: string | null; rssi: number | null };

export type DeviceObservation = {
  mac: string;
  // From the router (hotspot host table + DHCP lease).
  onNetwork: boolean;
  ip: string | null;
  hostName: string | null;
  dhcpClassId: string | null;
  // From Omada: an observation, null = Omada sees no radio link for it,
  // undefined = Omada wasn't available this round.
  radio?: RadioObservation | null;
};

export type DeviceEventDraft = {
  mac: string;
  at: Date;
  type: "first_seen" | "connected" | "disconnected" | "ip_changed" | "name_changed" | "ap_connected" | "roamed" | "band_changed";
  source: "router" | "omada";
  fromValue?: string | null;
  toValue?: string | null;
  detail?: Record<string, unknown>;
};

export function diffDevice(
  prev: DeviceState | null,
  obs: DeviceObservation | null,
  now: Date
): { next: DeviceState | null; events: DeviceEventDraft[] } {
  const events: DeviceEventDraft[] = [];
  if (!obs) {
    // Not on the router any more: one disconnect, then nothing until it returns.
    if (prev?.online) {
      events.push({ mac: prev.mac, at: now, type: "disconnected", source: "router", fromValue: prev.ip });
      return { next: { ...prev, online: false }, events };
    }
    return { next: prev, events };
  }

  const mac = obs.mac;
  const base: DeviceState = prev ?? {
    mac, firstSeenAt: now, lastSeenAt: now, online: false, ip: null, hostName: null, dhcpClassId: null,
    apMac: null, apName: null, ssid: null, band: null, rssi: null, signalAt: null
  };
  const next: DeviceState = { ...base, lastSeenAt: now, online: true };

  if (!prev) events.push({ mac, at: now, type: "first_seen", source: "router", toValue: obs.ip, detail: { hostName: obs.hostName, dhcpClassId: obs.dhcpClassId } });
  if (!base.online) events.push({ mac, at: now, type: "connected", source: "router", toValue: obs.ip });

  if (obs.ip && obs.ip !== base.ip) {
    if (prev && base.ip) events.push({ mac, at: now, type: "ip_changed", source: "router", fromValue: base.ip, toValue: obs.ip });
    next.ip = obs.ip;
  }
  if (obs.hostName && obs.hostName !== base.hostName) {
    if (prev && base.hostName) events.push({ mac, at: now, type: "name_changed", source: "router", fromValue: base.hostName, toValue: obs.hostName });
    next.hostName = obs.hostName;
  }
  if (obs.dhcpClassId) next.dhcpClassId = obs.dhcpClassId;

  const radio = obs.radio;
  if (radio) {
    if (radio.apMac !== base.apMac) {
      if (base.apMac) {
        events.push({
          mac, at: now, type: "roamed", source: "omada",
          fromValue: base.apName ?? base.apMac, toValue: radio.apName ?? radio.apMac,
          detail: { fromApMac: base.apMac, toApMac: radio.apMac, rssi: radio.rssi, band: radio.band }
        });
      } else {
        events.push({ mac, at: now, type: "ap_connected", source: "omada", toValue: radio.apName ?? radio.apMac, detail: { apMac: radio.apMac, rssi: radio.rssi, band: radio.band, ssid: radio.ssid } });
      }
    } else if (radio.band && base.band && radio.band !== base.band) {
      events.push({ mac, at: now, type: "band_changed", source: "omada", fromValue: base.band, toValue: radio.band, detail: { rssi: radio.rssi } });
    }
    Object.assign(next, { apMac: radio.apMac, apName: radio.apName, ssid: radio.ssid, band: radio.band, rssi: radio.rssi, signalAt: now });
  }
  return { next, events };
}
