import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { diffDevice, type DeviceObservation, type DeviceState } from "./deviceRegistry.js";
import { listOmadaRadios } from "./omada.js";
import { listNetworkHosts } from "./routeros.js";

const RETENTION_DAYS = 365;

// One collection round: router decides who is on the network, Omada adds
// radio facts when reachable; diffDevice turns the change into events.
export async function collectDevices(prisma: PrismaClient, now = new Date()) {
  if (!config.routeros.deviceCollector) return null;
  const hosts = await listNetworkHosts();
  // Without the router we can't tell who left, so skip the round entirely.
  if (!hosts) return { skipped: "router unavailable" as const };
  const radios = await listOmadaRadios();

  const observed = new Map<string, DeviceObservation>();
  for (const host of hosts) {
    observed.set(host.deviceMac, {
      mac: host.deviceMac, onNetwork: true, ip: host.address, hostName: host.hostName, dhcpClassId: host.dhcpClassId,
      radio: radios ? radios.get(host.deviceMac) ?? null : undefined
    });
  }
  const prevRows = await prisma.wifiDevice.findMany({ where: { OR: [{ mac: { in: [...observed.keys()] } }, { online: true }] } });
  const prev = new Map<string, DeviceState>(prevRows.map((row) => [row.mac, row]));

  let eventsWritten = 0;
  for (const mac of new Set([...observed.keys(), ...prev.keys()])) {
    const { next, events } = diffDevice(prev.get(mac) ?? null, observed.get(mac) ?? null, now);
    if (!next) continue;
    const before = prev.get(mac);
    const changed = !before || events.length > 0 || before.lastSeenAt.getTime() !== next.lastSeenAt.getTime() || before.rssi !== next.rssi;
    if (!changed) continue;
    const { mac: _mac, ...data } = next;
    await prisma.$transaction([
      prisma.wifiDevice.upsert({ where: { mac }, create: next, update: data }),
      ...(events.length > 0 ? [prisma.wifiDeviceEvent.createMany({ data: events.map((e) => ({ ...e, detail: e.detail as object | undefined })) })] : [])
    ]);
    eventsWritten += events.length;
  }
  return { hosts: hosts.length, omada: radios ? radios.size : null, eventsWritten };
}

// 12-month history, as agreed for Client Intelligence.
export async function pruneDeviceHistory(prisma: PrismaClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 3600 * 1000);
  const events = await prisma.wifiDeviceEvent.deleteMany({ where: { at: { lt: cutoff } } });
  const devices = await prisma.wifiDevice.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
  return { events: events.count, devices: devices.count };
}
