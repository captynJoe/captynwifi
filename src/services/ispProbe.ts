import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { probeIspThroughput, setFairShareLimit } from "./routeros.js";

// Pure: the fair queue's ceiling for a measured line speed. 90% keeps the
// queue at the router (not the ISP), so the router decides who gets what.
export const FAIR_SHARE_OPEN_MBPS = 90;
export function fairShareLimitMbps(lineMbps: number) {
  return Math.min(90, Math.max(8, Math.round(lineMbps * 0.9)));
}

// Evening ISP probe. On 24 Nov 2026 the WAN sat flat at ~20-23 Mbps from 8 to
// 11 pm, then carried ~70 Mbps after midnight with the router idle, so the
// limit looked like the ISP. These readings are the record to show them.

const PROBE_URL = "https://speed.cloudflare.com/__down?bytes=10000000";
const RETENTION_DAYS = 180;

// Due every 30 minutes, day and night, so the fair-share limit follows the
// line within half an hour of it changing (e.g. back to ~70 Mbps after the
// evening cap lifts). A 10 MB test each time.
export function ispProbeDue(now: Date, last: Date | null) {
  const eat = new Date(now.getTime() + 3 * 3600 * 1000);
  const minutes = eat.getUTCHours() * 60 + eat.getUTCMinutes();
  const slot = Math.floor(minutes / 30) * 30;
  const slotStart = now.getTime() - (minutes - slot) * 60 * 1000 - eat.getUTCSeconds() * 1000 - eat.getUTCMilliseconds();
  return !last || last.getTime() < slotStart;
}

export function mbps(bytes: number, seconds: number) {
  return seconds > 0 ? Math.round(((bytes * 8) / seconds / 1_000_000) * 10) / 10 : null;
}

// force: an admin pressed "Test now" (Capacity page) -- run regardless of
// the schedule (the route limits how often).
export async function runIspProbe(prisma: PrismaClient, now = new Date(), { force = false } = {}) {
  if (!config.routeros.ispProbe && !force) return null;
  const last = await prisma.wifiIspProbe.findFirst({ orderBy: { at: "desc" }, select: { at: true } });
  if (!force && !ispProbeDue(now, last?.at ?? null)) return null;
  try {
    const reading = await probeIspThroughput(PROBE_URL);
    const probeMbps = mbps(reading.bytes, reading.seconds);
    const customerMbps = reading.customerMbps === null ? null : Math.round(reading.customerMbps * 10) / 10;
    const totalMbps = probeMbps !== null && customerMbps !== null ? Math.round((probeMbps + customerMbps) * 10) / 10 : null;
    const probe = await prisma.wifiIspProbe.create({
      data: { probeMbps, customerMbps, totalMbps, bytes: reading.bytes, seconds: reading.seconds }
    });
    if (config.routeros.fairShare && totalMbps !== null) {
      const set = await setFairShareLimit(fairShareLimitMbps(totalMbps));
      if (set) console.log(`Fair share: line ${totalMbps} Mbps, queue ${set.previous} -> ${set.next}`);
      else console.warn("Fair share: queue captyn-fair-down not found or router unavailable");
    }
    return probe;
  } catch (error) {
    // Can't measure the line: open the fair queue rather than keep a stale,
    // possibly low limit. When unsure, never throttle.
    if (config.routeros.fairShare) {
      const set = await setFairShareLimit(FAIR_SHARE_OPEN_MBPS);
      if (set) console.warn(`Fair share: probe failed, queue opened ${set.previous} -> ${set.next}`);
    }
    return prisma.wifiIspProbe.create({ data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

export async function pruneIspProbes(prisma: PrismaClient, now = new Date()) {
  await prisma.wifiIspProbe.deleteMany({ where: { at: { lt: new Date(now.getTime() - RETENTION_DAYS * 86400 * 1000) } } });
}
