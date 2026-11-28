import { Prisma, type PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { probeLines, sampleFairShare, setFairShareLimit, type FairShareSample, type LineReading } from "./routeros.js";

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
    // Each internet line on its own (config.routeros.wanLines); the fair
    // queue gets their sum. A line that fails to test counts as 0 here.
    const lines = await probeLines(PROBE_URL, config.routeros.wanLines);
    const measuredLines = lines.filter((line) => line.totalMbps !== null);
    if (measuredLines.length === 0) throw new Error(lines.map((line) => `${line.label}: ${line.error ?? "no reading"}`).join("; "));
    const round1 = (value: number) => Math.round(value * 10) / 10;
    const probeMbps = round1(measuredLines.reduce((sum, line) => sum + (line.testMbps ?? 0), 0));
    const customerMbps = round1(measuredLines.reduce((sum, line) => sum + (line.customerMbps ?? 0), 0));
    const totalMbps = round1(measuredLines.reduce((sum, line) => sum + (line.totalMbps ?? 0), 0));
    const probe = await prisma.wifiIspProbe.create({
      data: { probeMbps, customerMbps, totalMbps, lines: lines as unknown as object }
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

// Pure: the download capacity to judge "how busy" against -- the line as
// measured in the last 45 minutes, else the configured figure. The fixed
// 80 Mbps read a full ~22 Mbps evening line as "quiet", so the dynamic plan
// menu got cheaper and faster exactly when the line was full.
export function lineCapacityMbps(latest: { at: Date; totalMbps: number | null } | null, fallbackMbps: number, now = new Date()) {
  if (latest?.totalMbps && now.getTime() - latest.at.getTime() <= 45 * 60 * 1000) return latest.totalMbps;
  return fallbackMbps;
}

export async function measuredLineCapacityMbps(prisma: PrismaClient, fallbackMbps: number, now = new Date()) {
  const latest = await prisma.wifiIspProbe.findFirst({ where: { totalMbps: { not: null } }, orderBy: { at: "desc" }, select: { at: true, totalMbps: true } });
  return lineCapacityMbps(latest, fallbackMbps, now);
}

// Pure: bytes received on one line between readings of its counter. The
// counter restarts at 0 when the router reboots: a drop means "count from
// zero again", not a negative amount.
export function counterUsageBytes(readings: number[]): number {
  let total = 0;
  for (let i = 1; i < readings.length; i += 1) {
    const delta = readings[i] - readings[i - 1];
    total += delta >= 0 ? delta : readings[i];
  }
  return total;
}

// Per line: the latest reading and data received this month (from the
// counters recorded with each probe; FUP early warning).
export async function lineSummaries(prisma: PrismaClient, now = new Date()) {
  const eat = new Date(now.getTime() + 3 * 3600 * 1000);
  const monthStart = new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), 1) - 3 * 3600 * 1000);
  const probes = await prisma.wifiIspProbe.findMany({
    where: { at: { gte: monthStart }, lines: { not: Prisma.DbNull } },
    orderBy: { at: "asc" },
    select: { at: true, lines: true }
  });
  const byIface = new Map<string, { label: string; latest: LineReading & { at: Date }; counters: number[] }>();
  for (const probe of probes) {
    for (const line of (probe.lines as unknown as LineReading[]) ?? []) {
      const entry = byIface.get(line.iface) ?? { label: line.label, latest: { ...line, at: probe.at }, counters: [] };
      entry.label = line.label;
      entry.latest = { ...line, at: probe.at };
      if (typeof line.rxBytes === "number") entry.counters.push(line.rxBytes);
      byIface.set(line.iface, entry);
    }
  }
  return [...byIface.entries()].map(([iface, entry]) => ({
    iface,
    label: entry.label,
    latest: entry.latest,
    monthReceivedGb: Math.round(counterUsageBytes(entry.counters) / 1e9),
    since: probes[0]?.at ?? null
  }));
}

// ---- Fair queue guard (every 30 s) ----------------------------------------
// The queue must never be what holds customers back. If it's full while the
// line's ping is still at its quiet baseline, the ISP has room: raise the
// limit now (not at the next 30-minute test). If the ping climbs well above
// baseline three looks in a row while the queue is busy, the ISP line is
// full: settle just under what's actually flowing, never below half the last
// measured line or 15 Mbps.
export type GuardState = { baselineMs: number | null; recentPings: number[]; highPingRun: number; lastLowerAt?: number };
// After settling under a full ISP line, wait before raising again, so the
// guard doesn't cycle raise -> ISP fills -> lower every couple of minutes.
const GUARD_RAISE_HOLD_MS = 10 * 60 * 1000;

export function guardDecision(
  sample: FairShareSample,
  state: GuardState,
  bounds: { maxMbps: number; minMbps: number },
  now = Date.now()
): { limit: number | null; reason: string } {
  const { limitMbps, rateMbps, queuedBytes, pingMs } = sample;
  if (pingMs === null || state.baselineMs === null) return { limit: null, reason: "no ping" };
  const full = rateMbps >= limitMbps * 0.95 && queuedBytes > 0;
  const lineQuiet = pingMs <= state.baselineMs + 8;
  const lineBusy = pingMs >= state.baselineMs + 20;
  const holdingAfterLower = state.lastLowerAt !== undefined && now - state.lastLowerAt < GUARD_RAISE_HOLD_MS;
  if (full && lineQuiet && limitMbps < bounds.maxMbps && !holdingAfterLower) {
    return { limit: Math.min(bounds.maxMbps, Math.max(limitMbps + 5, Math.round(limitMbps * 1.2))), reason: `queue full, line ping ${pingMs.toFixed(0)} ms (baseline ${state.baselineMs.toFixed(0)}): raise` };
  }
  if (lineBusy && rateMbps >= limitMbps * 0.8 && state.highPingRun >= 3) {
    const target = Math.max(bounds.minMbps, Math.round(rateMbps * 0.9));
    if (target < limitMbps) return { limit: target, reason: `line ping ${pingMs.toFixed(0)} ms (baseline ${state.baselineMs.toFixed(0)}): ISP full, settle under it` };
  }
  return { limit: null, reason: "steady" };
}

const guardState: GuardState = { baselineMs: null, recentPings: [], highPingRun: 0 };

export async function runFairShareGuard(prisma: PrismaClient) {
  if (!config.routeros.fairShare) return null;
  const sample = await sampleFairShare();
  if (!sample || sample.pingMs === null) return null;
  // Baseline = the quietest ping in the last ~30 minutes of looks.
  guardState.recentPings = [...guardState.recentPings, sample.pingMs].slice(-60);
  guardState.baselineMs = Math.min(...guardState.recentPings);
  guardState.highPingRun = sample.pingMs >= guardState.baselineMs + 20 ? guardState.highPingRun + 1 : 0;
  const latest = await prisma.wifiIspProbe.findFirst({ where: { totalMbps: { not: null } }, orderBy: { at: "desc" }, select: { totalMbps: true, lines: true } });
  const links = ((latest?.lines as unknown as LineReading[]) ?? []).reduce((sum, line) => sum + (line.linkMbps ?? 0), 0);
  const bounds = {
    maxMbps: links > 0 ? links : FAIR_SHARE_OPEN_MBPS,
    minMbps: Math.max(FAIR_SHARE_FLOOR_MBPS, Math.round((latest?.totalMbps ?? 0) * 0.5))
  };
  const decision = guardDecision(sample, guardState, bounds);
  if (decision.limit === null || decision.limit === sample.limitMbps) return { sample, decision };
  const set = await setFairShareLimit(decision.limit);
  if (set && decision.limit < sample.limitMbps) guardState.lastLowerAt = Date.now();
  if (set) console.log(`Fair share guard: ${decision.reason}: ${sample.limitMbps}M -> ${set.next} (passing ${sample.rateMbps.toFixed(1)} Mbps)`);
  return { sample, decision };
}
