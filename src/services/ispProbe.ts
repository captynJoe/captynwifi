import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { probeIspThroughput } from "./routeros.js";

// Evening ISP probe. On 24 Nov 2026 the WAN sat flat at ~20-23 Mbps from 8 to
// 11 pm, then carried ~70 Mbps after midnight with the router idle, so the
// limit looked like the ISP. These readings are the record to show them.

const PROBE_URL = "https://speed.cloudflare.com/__down?bytes=10000000";
const RETENTION_DAYS = 180;

// Due every 30 minutes from 19:00 to 23:30 EAT, plus one 03:00 baseline.
export function ispProbeDue(now: Date, last: Date | null) {
  const eat = new Date(now.getTime() + 3 * 3600 * 1000);
  const minutes = eat.getUTCHours() * 60 + eat.getUTCMinutes();
  const slot = minutes >= 19 * 60 ? Math.floor(minutes / 30) * 30 : minutes >= 3 * 60 && minutes < 3 * 60 + 30 ? 3 * 60 : null;
  if (slot === null) return false;
  const slotStart = now.getTime() - (minutes - slot) * 60 * 1000 - eat.getUTCSeconds() * 1000 - eat.getUTCMilliseconds();
  return !last || last.getTime() < slotStart;
}

export function mbps(bytes: number, seconds: number) {
  return seconds > 0 ? Math.round(((bytes * 8) / seconds / 1_000_000) * 10) / 10 : null;
}

export async function runIspProbe(prisma: PrismaClient, now = new Date()) {
  if (!config.routeros.ispProbe) return null;
  const last = await prisma.wifiIspProbe.findFirst({ orderBy: { at: "desc" }, select: { at: true } });
  if (!ispProbeDue(now, last?.at ?? null)) return null;
  try {
    const reading = await probeIspThroughput(PROBE_URL);
    const probeMbps = mbps(reading.bytes, reading.seconds);
    const customerMbps = reading.customerMbps === null ? null : Math.round(reading.customerMbps * 10) / 10;
    return await prisma.wifiIspProbe.create({
      data: {
        probeMbps, customerMbps,
        totalMbps: probeMbps !== null && customerMbps !== null ? Math.round((probeMbps + customerMbps) * 10) / 10 : null,
        bytes: reading.bytes, seconds: reading.seconds
      }
    });
  } catch (error) {
    return prisma.wifiIspProbe.create({ data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

export async function pruneIspProbes(prisma: PrismaClient, now = new Date()) {
  await prisma.wifiIspProbe.deleteMany({ where: { at: { lt: new Date(now.getTime() - RETENTION_DAYS * 86400 * 1000) } } });
}
