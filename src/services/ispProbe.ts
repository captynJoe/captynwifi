import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { probeIspThroughput, setFairShareLimit } from "./routeros.js";

// Pure: the fair queue's ceiling for a measured line speed. 90% keeps the
// queue at the router (not the ISP), so the router decides who gets what.
// "Open" is far above any line we have, so a test is never capped by it.
export const FAIR_SHARE_OPEN_MBPS = 1000;
const FAIR_SHARE_OPEN_SETTLE_MS = 4000;
const FAIR_SHARE_FLOOR_MBPS = 15;
export function fairShareLimitMbps(lineMbps: number) {
  return Math.min(FAIR_SHARE_OPEN_MBPS, Math.max(FAIR_SHARE_FLOOR_MBPS, Math.round(lineMbps * 0.9)));
}

// Pure: what to set, given the limit before this test, this test's limit
// and the previous test's (if recent). Too high is harmless (the queue just
// doesn't engage); too low throttles everyone for half an hour. So: rise at
// once, but only lower when two tests in a row say so -- and then to the
// higher of the two. One unlucky reading can't hold the network down.
export function decideFairShareLimit(previousMbps: number | null, candidateMbps: number, lastCandidateMbps: number | null): number {
  if (previousMbps === null || candidateMbps >= previousMbps) return candidateMbps;
  if (lastCandidateMbps !== null && lastCandidateMbps < previousMbps) return Math.max(candidateMbps, lastCandidateMbps);
  return previousMbps;
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
  const last = await prisma.wifiIspProbe.findFirst({ orderBy: { at: "desc" }, select: { at: true, totalMbps: true } });
  if (!force && !ispProbeDue(now, last?.at ?? null)) return null;
  let limitBefore: number | null = null;
  try {
    // Measure the LINE, not our own queue: while the fair queue is limiting
    // customers, "customers + one test download" only ever reads about the
    // current limit, so the limit chased itself downward (27 Nov: held at
    // 20-26 Mbps on a line giving 65). Open it for the test, let customers'
    // traffic grow into the room, then measure.
    if (config.routeros.fairShare) {
      const opened = await setFairShareLimit(FAIR_SHARE_OPEN_MBPS);
      const before = Number(opened?.previous);
      limitBefore = Number.isFinite(before) && before > 0 ? Math.round(before / 1_000_000) : null;
      await new Promise((resolve) => setTimeout(resolve, FAIR_SHARE_OPEN_SETTLE_MS));
    }
    const reading = await probeIspThroughput(PROBE_URL);
    const probeMbps = mbps(reading.bytes, reading.seconds);
    const customerMbps = reading.customerMbps === null ? null : Math.round(reading.customerMbps * 10) / 10;
    const measured = probeMbps !== null && customerMbps !== null ? Math.round((probeMbps + customerMbps) * 10) / 10 : null;
    const totalMbps = measured !== null && reading.linkMbps ? Math.min(measured, reading.linkMbps) : measured;
    const probe = await prisma.wifiIspProbe.create({
      data: { probeMbps, customerMbps, totalMbps, bytes: reading.bytes, seconds: reading.seconds }
    });
    if (config.routeros.fairShare && totalMbps !== null) {
      const recentPrevious = last?.totalMbps != null && now.getTime() - last.at.getTime() <= 45 * 60 * 1000 ? fairShareLimitMbps(last.totalMbps) : null;
      const target = decideFairShareLimit(limitBefore, fairShareLimitMbps(totalMbps), recentPrevious);
      const set = await setFairShareLimit(target);
      if (set) {
        console.log(`Fair share: line ${totalMbps} Mbps, queue ${limitBefore ?? "?"}M -> ${set.next}${target === limitBefore && fairShareLimitMbps(totalMbps) < target ? " (held: lowers need two tests in a row)" : ""}`);
      } else console.warn("Fair share: queue captyn-fair-down not found or router unavailable");
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

// Watchdog run by the API process: if the RADIUS worker (which runs the
// probes) hasn't measured the line for 70 minutes, open the fair queue so a
// stuck worker can't leave everyone on a stale, low limit. The router's
// Netwatch covers the whole server being unreachable (docs/fair-share.rsc).
export async function fairShareWatchdog(prisma: PrismaClient, now = new Date()) {
  if (!config.routeros.fairShare) return null;
  const lastGood = await prisma.wifiIspProbe.findFirst({ where: { totalMbps: { not: null } }, orderBy: { at: "desc" }, select: { at: true } });
  if (lastGood && now.getTime() - lastGood.at.getTime() < 70 * 60 * 1000) return null;
  const set = await setFairShareLimit(FAIR_SHARE_OPEN_MBPS);
  if (set && set.previous !== String(FAIR_SHARE_OPEN_MBPS * 1_000_000)) console.warn(`Fair share watchdog: no line measurement for 70 min, queue opened ${set.previous} -> ${set.next}`);
  return set;
}
