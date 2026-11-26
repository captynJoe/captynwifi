import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { listActiveHotspotSessions } from "./routeros.js";

// Client Intelligence alerts, checked hourly. Each rule reports what it sees
// now; alerts no longer seen are resolved. Facts only: every alert names the
// package or device and the records behind it, for Trace to follow.

export type AlertCandidate = { key: string; rule: string; subject: string; title: string; detail?: Record<string, unknown> };
type OpenAlert = { id: string; key: string };

export function planAlertChanges(open: OpenAlert[], seen: AlertCandidate[]) {
  const openKeys = new Set(open.map((a) => a.key));
  const seenKeys = new Set(seen.map((a) => a.key));
  return {
    create: seen.filter((a) => !openKeys.has(a.key)),
    refresh: open.filter((a) => seenKeys.has(a.key)),
    resolve: open.filter((a) => !seenKeys.has(a.key))
  };
}

type Probe = { at: Date; totalMbps: number | null };

// Tonight's evening probes against the latest 3 am baseline: alert when at
// least three evening readings carried under half the baseline.
export function ispCapAlert(probes: Probe[], now: Date): AlertCandidate | null {
  const eatHour = (d: Date) => (d.getUTCHours() + 3) % 24;
  const measured = probes.filter((p): p is { at: Date; totalMbps: number } => p.totalMbps !== null);
  const baseline = measured.filter((p) => eatHour(p.at) < 6).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (!baseline) return null;
  const since = now.getTime() - 12 * 3600 * 1000;
  const evening = measured.filter((p) => eatHour(p.at) >= 19 && p.at.getTime() >= since);
  const slow = evening.filter((p) => p.totalMbps < baseline.totalMbps / 2);
  if (slow.length < 3) return null;
  const worst = Math.min(...slow.map((p) => p.totalMbps));
  const night = new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  return {
    key: `isp_cap:${night}`, rule: "isp_cap", subject: "ISP line",
    title: `ISP line carried ${worst}–${Math.max(...slow.map((p) => p.totalMbps))} Mbps this evening vs ${baseline.totalMbps} Mbps at 3 am`,
    detail: { baselineMbps: baseline.totalMbps, baselineAt: baseline.at, slowReadings: slow.length, eveningReadings: evening.length }
  };
}

export async function collectAlertCandidates(prisma: PrismaClient, now = new Date()): Promise<AlertCandidate[]> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const candidates: AlertCandidate[] = [];

  // Packages used by more devices than they allow in the last 24 hours.
  const overCap = await prisma.$queryRaw<Array<{ username: string; cap: number; macs: string[] }>>`
    WITH used AS (
      SELECT username, array_agg(DISTINCT upper(callingstationid)) AS macs
      FROM radacct
      WHERE coalesce(acctstoptime, acctupdatetime, acctstarttime) >= ${since} AND coalesce(callingstationid, '') <> ''
      GROUP BY username
    ), latest AS (
      SELECT DISTINCT ON (username) username, captyn_device_cap("deviceLimit", "startsAt", "expiresAt") AS cap
      FROM "WifiEntitlement" ORDER BY username, "createdAt" DESC
    )
    SELECT used.username, latest.cap, used.macs FROM used JOIN latest USING (username)
    WHERE cardinality(used.macs) > latest.cap`;
  for (const row of overCap) {
    candidates.push({
      key: `package_over_cap:${row.username}`, rule: "package_over_cap", subject: row.username,
      title: `Package ${row.username} used by ${row.macs.length} devices in 24 h (allows ${row.cap})`,
      detail: { macs: row.macs, cap: row.cap }
    });
  }

  // One device on packages belonging to two or more different numbers in
  // the last 24 hours (a shared login or someone else's device code). One
  // customer buying short packages back to back is normal and not flagged;
  // free promo grants don't count.
  const shared = await prisma.$queryRaw<Array<{ mac: string; usernames: string[]; phones: number }>>`
    SELECT upper(r.callingstationid) AS mac, array_agg(DISTINCT r.username) AS usernames, count(DISTINCT e."customerPhone")::int AS phones
    FROM radacct r JOIN "WifiEntitlement" e ON e.username = r.username
    WHERE coalesce(r.acctstoptime, r.acctupdatetime, r.acctstarttime) >= ${since} AND coalesce(r.callingstationid, '') <> ''
      AND e."customerPhone" ~ '^\+?254[17][0-9]{8}$'
    GROUP BY 1 HAVING count(DISTINCT e."customerPhone") >= 2`;
  for (const row of shared) {
    candidates.push({
      key: `device_shared_packages:${row.mac}`, rule: "device_shared_packages", subject: row.mac,
      title: `Device ${row.mac} used packages of ${row.phones} different numbers in 24 h`,
      detail: { usernames: row.usernames, phones: row.phones }
    });
  }

  // Online on the router with no open RADIUS session. Skipped (not guessed)
  // when the router doesn't answer.
  const active = await listActiveHotspotSessions();
  if (active) {
    const open = await prisma.$queryRaw<Array<{ username: string; mac: string }>>`
      SELECT DISTINCT username, upper(callingstationid) AS mac FROM radacct WHERE acctstoptime IS NULL`;
    const openKeys = new Set(open.map((r) => `${r.username}|${r.mac}`));
    for (const session of active) {
      if (openKeys.has(`${session.user}|${session.deviceMac}`)) continue;
      candidates.push({
        key: `router_without_radius:${session.user}:${session.deviceMac}`, rule: "router_without_radius", subject: session.deviceMac,
        title: `${session.deviceMac} is online as ${session.user} on the router with no open RADIUS session`,
        detail: { username: session.user }
      });
    }
  }

  const probes = await prisma.wifiIspProbe.findMany({
    where: { at: { gte: new Date(now.getTime() - 36 * 3600 * 1000) } },
    select: { at: true, totalMbps: true }
  });
  const isp = ispCapAlert(probes, now);
  if (isp) candidates.push(isp);
  return candidates;
}

export async function runIntelAlerts(prisma: PrismaClient, now = new Date()) {
  if (!config.routeros.deviceCollector) return null;
  const seen = await collectAlertCandidates(prisma, now);
  const open = await prisma.wifiIntelAlert.findMany({ where: { resolvedAt: null }, select: { id: true, key: true } });
  const plan = planAlertChanges(open, seen);
  const byKey = new Map(seen.map((a) => [a.key, a]));
  await prisma.$transaction([
    ...plan.create.map((a) => prisma.wifiIntelAlert.create({
      data: { key: a.key, rule: a.rule, subject: a.subject, title: a.title, detail: a.detail as object | undefined, firstSeenAt: now, lastSeenAt: now }
    })),
    ...plan.refresh.map((a) => {
      const latest = byKey.get(a.key)!;
      return prisma.wifiIntelAlert.update({ where: { id: a.id }, data: { lastSeenAt: now, title: latest.title, detail: latest.detail as object | undefined } });
    }),
    ...(plan.resolve.length ? [prisma.wifiIntelAlert.updateMany({ where: { id: { in: plan.resolve.map((a) => a.id) } }, data: { resolvedAt: now } })] : [])
  ]);
  return { opened: plan.create.length, stillOpen: plan.refresh.length, resolved: plan.resolve.length };
}
