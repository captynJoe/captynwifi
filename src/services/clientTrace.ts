import type { PrismaClient } from "@prisma/client";
import { normalizeDeviceMac } from "./radiusProjection.js";
import { listActiveHotspotSessions } from "./routeros.js";

// Trace Any Client: from any identifier (MAC, IP, username, voucher, M-PESA
// receipt, phone, device name) rebuild device -> RADIUS sessions -> username
// -> package -> payment -> phone from records CAPTYN already keeps.
//
// Every link says how it is known. A link is only "confirmed" when a record
// ties the two ends together directly (an accounting row, a package's own
// payment, M-PESA's confirmation). Nothing is ever attributed because a phone
// number or a time looks similar; what can't be tied is reported unresolved.

export type LinkStatus = "confirmed" | "unresolved";
export type TraceLink = { status: LinkStatus; source: string };

export type TraceQueryKind = "mac" | "ip" | "phone" | "receipt" | "hostname" | "username";

const MAX_DEVICES = 10;
const MAX_SESSIONS = 50;

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "•••";
  return `${digits.slice(0, 4)}••••${digits.slice(-3)}`;
}

export function classifyTraceQuery(raw: string): { kind: TraceQueryKind; value: string } {
  const value = raw.trim();
  const mac = normalizeDeviceMac(value);
  if (mac && /[:\-.]|^[0-9a-f]{12}$/i.test(value)) return { kind: "mac", value: mac };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return { kind: "ip", value };
  const digits = value.replace(/[\s+\-]/g, "");
  if (/^(254|0)?[17]\d{8}$/.test(digits)) {
    const local = digits.replace(/^(254|0)/, "");
    return { kind: "phone", value: `254${local}` };
  }
  // M-PESA receipts are 10 upper-case letters/digits, e.g. UKH1G2LCOF.
  if (/^[A-Z0-9]{10}$/.test(value) && /\d/.test(value) && /[A-Z]/.test(value)) return { kind: "receipt", value };
  if (/^ws_CO_/i.test(value)) return { kind: "receipt", value };
  if (/[a-z]/.test(value) && /[-_ ]/.test(value) && !/^CG-|^promo-|^free-/i.test(value)) return { kind: "hostname", value };
  return { kind: "username", value };
}

type SessionRow = {
  username: string;
  mac: string;
  ip: string | null;
  start: Date;
  stop: Date | null;
  updated: Date | null;
  seconds: bigint | number | null;
  bytes: bigint | number | null;
  cause: string | null;
};

async function seedFromQuery(prisma: PrismaClient, kind: TraceQueryKind, value: string) {
  const macs = new Set<string>();
  const usernames = new Set<string>();
  if (kind === "mac") macs.add(value);
  if (kind === "ip") {
    const rows = await prisma.$queryRaw<Array<{ mac: string }>>`
      SELECT DISTINCT upper(callingstationid) AS mac FROM radacct
      WHERE framedipaddress = ${value}::inet AND callingstationid IS NOT NULL AND callingstationid <> ''
      ORDER BY 1 LIMIT ${MAX_DEVICES}`;
    rows.forEach((row) => macs.add(row.mac));
  }
  if (kind === "username") usernames.add(value);
  if (kind === "phone") {
    const entitlements = await prisma.wifiEntitlement.findMany({ where: { customerPhone: value }, select: { username: true }, take: 50 });
    entitlements.forEach((e) => usernames.add(e.username));
    const intents = await prisma.wifiPaymentIntent.findMany({ where: { customerPhone: value, deviceMac: { not: null } }, select: { deviceMac: true }, take: 50 });
    intents.forEach((i) => i.deviceMac && macs.add(i.deviceMac.toUpperCase()));
  }
  if (kind === "receipt") {
    const intent = await prisma.wifiPaymentIntent.findFirst({
      where: { OR: [{ receiptNumber: value }, { providerReference: value }] },
      select: { deviceMac: true, entitlement: { select: { username: true } }, targetEntitlementId: true }
    });
    if (intent?.entitlement) usernames.add(intent.entitlement.username);
    if (intent?.targetEntitlementId) {
      const target = await prisma.wifiEntitlement.findUnique({ where: { id: intent.targetEntitlementId }, select: { username: true } });
      if (target) usernames.add(target.username);
    }
    if (intent?.deviceMac) macs.add(intent.deviceMac.toUpperCase());
  }
  if (kind === "hostname") {
    const devices = await prisma.wifiEntitlementDevice.findMany({
      where: { hostName: { contains: value, mode: "insensitive" } }, select: { deviceMac: true }, take: MAX_DEVICES
    });
    devices.forEach((d) => macs.add(d.deviceMac.toUpperCase()));
  }
  // An account search also traces the devices that used it.
  if (usernames.size > 0) {
    const rows = await prisma.$queryRaw<Array<{ mac: string }>>`
      SELECT DISTINCT upper(callingstationid) AS mac FROM radacct
      WHERE username = ANY(${[...usernames]}) AND callingstationid IS NOT NULL AND callingstationid <> ''
      LIMIT ${MAX_DEVICES}`;
    rows.forEach((row) => macs.add(row.mac));
    const ledger = await prisma.wifiEntitlementDevice.findMany({
      where: { entitlement: { username: { in: [...usernames] } } }, select: { deviceMac: true }, take: MAX_DEVICES
    });
    ledger.forEach((d) => macs.add(d.deviceMac.toUpperCase()));
  }
  return { macs: [...macs].slice(0, MAX_DEVICES), usernames: [...usernames] };
}

export async function traceClient(prisma: PrismaClient, query: string) {
  const { kind, value } = classifyTraceQuery(query);
  const seed = await seedFromQuery(prisma, kind, value);
  const liveSessions = (await listActiveHotspotSessions().catch(() => null)) ?? null;

  const devices = [];
  const allUsernames = new Set(seed.usernames);
  for (const mac of seed.macs) {
    // Before the 2026-11-23 RADIUS fix one connection could be stored twice
    // (same router session id, starts a second apart). Keep the most complete
    // copy of each so counts, hours and data aren't doubled.
    const sessions = await prisma.$queryRaw<SessionRow[]>`
      SELECT * FROM (
        SELECT DISTINCT ON (username, acctsessionid, date_trunc('minute', acctstarttime))
               username, upper(callingstationid) AS mac, host(framedipaddress) AS ip, acctstarttime AS start,
               acctstoptime AS stop, acctupdatetime AS updated, acctsessiontime AS seconds,
               coalesce(acctinputoctets, 0) + coalesce(acctoutputoctets, 0) AS bytes, acctterminatecause AS cause
        FROM radacct WHERE upper(callingstationid) = ${mac}
        ORDER BY username, acctsessionid, date_trunc('minute', acctstarttime),
                 acctsessiontime DESC NULLS LAST, (acctinputoctets + acctoutputoctets) DESC NULLS LAST
      ) s ORDER BY start DESC`;
    const ledger = await prisma.wifiEntitlementDevice.findMany({
      where: { deviceMac: mac },
      select: { hostName: true, dhcpClassId: true, identitySeenAt: true, addedAt: true, signedOutAt: true, entitlement: { select: { username: true } } },
      orderBy: { addedAt: "desc" }
    });
    const failedPayments = await prisma.wifiPaymentIntent.findMany({
      where: { deviceMac: mac, status: "failed" }, select: { createdAt: true, amountKsh: true }, orderBy: { createdAt: "desc" }, take: 20
    });
    sessions.forEach((s) => allUsernames.add(s.username));
    ledger.forEach((d) => allUsernames.add(d.entitlement.username));

    const seconds = sessions.reduce((sum, s) => sum + Number(s.seconds ?? 0), 0);
    const bytes = sessions.reduce((sum, s) => sum + Number(s.bytes ?? 0), 0);
    const live = liveSessions?.find((s) => s.deviceMac === mac);
    const identity = ledger.find((d) => d.hostName || d.dhcpClassId);
    const firstSeen = sessions.at(-1)?.start ?? ledger.at(-1)?.addedAt ?? null;
    const lastSeen = sessions[0] ? (sessions[0].stop ?? sessions[0].updated ?? sessions[0].start) : ledger[0]?.addedAt ?? null;
    devices.push({
      mac,
      hostName: identity?.hostName ?? null,
      deviceClass: identity?.dhcpClassId ?? null,
      online: live ? { as: live.user } : liveSessions ? null : "unknown",
      firstSeen,
      lastSeen,
      ips: [...new Set(sessions.map((s) => s.ip).filter(Boolean))],
      sessionCount: sessions.length,
      totalHours: Math.round((seconds / 3600) * 10) / 10,
      totalGb: Math.round((bytes / 1e9) * 100) / 100,
      sessions: sessions.slice(0, MAX_SESSIONS).map((s) => ({
        username: s.username, ip: s.ip, start: s.start, end: s.stop ?? null, lastUpdate: s.updated,
        minutes: Math.round(Number(s.seconds ?? 0) / 60), mb: Math.round(Number(s.bytes ?? 0) / 1e6), endedBy: s.cause
      })),
      accounts: [...new Set([...sessions.map((s) => s.username), ...ledger.map((d) => d.entitlement.username)])].map((username) => ({
        username,
        link: sessions.some((s) => s.username === username)
          ? { status: "confirmed", source: "RADIUS accounting (router-reported session)" }
          : { status: "confirmed", source: "Registered on the package (device ledger)" }
      })),
      failedPayments: { count: failedPayments.length, last: failedPayments[0]?.createdAt ?? null }
    });
  }

  const entitlements = allUsernames.size === 0 ? [] : await prisma.wifiEntitlement.findMany({
    where: { username: { in: [...allUsernames] } },
    include: { plan: { select: { name: true } }, paymentIntent: true, devices: { select: { deviceMac: true, signedOutAt: true } } },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  const addOns = entitlements.length === 0 ? [] : await prisma.wifiPaymentIntent.findMany({
    where: { targetEntitlementId: { in: entitlements.map((e) => e.id) } },
    orderBy: { createdAt: "desc" }
  });

  const payment = (intent: (typeof addOns)[number], devicesTraced: string[]) => {
    const isMpesa = intent.provider === "mpesa";
    const paid = intent.status === "activated" || intent.status === "confirmed";
    return {
      id: intent.id,
      purpose: intent.purpose,
      provider: intent.provider,
      status: intent.status,
      amountKsh: intent.amountKsh,
      reference: intent.receiptNumber ?? (isMpesa ? intent.providerReference : null),
      at: intent.confirmedAt ?? intent.createdAt,
      phoneMasked: isMpesa && paid ? maskPhone(intent.customerPhone) : null,
      phoneLink: isMpesa && paid
        ? { status: "confirmed", source: "M-PESA payment confirmation" }
        : { status: "unresolved", source: isMpesa ? "Payment not completed" : `No phone: ${intent.provider} access` },
      paidFromTracedDevice: Boolean(intent.deviceMac && devicesTraced.includes(intent.deviceMac.toUpperCase()))
    };
  };

  const traced = devices.map((d) => d.mac);
  return {
    query: { kind, value },
    devices,
    packages: entitlements.map((e) => ({
      username: e.username,
      plan: e.plan.name,
      status: e.status,
      startsAt: e.startsAt,
      expiresAt: e.expiresAt,
      deviceLimit: e.deviceLimit,
      registeredDevices: e.devices.filter((d) => !d.signedOutAt).length,
      link: { status: "confirmed", source: "Package record for this username" },
      payment: payment(e.paymentIntent, traced),
      paymentLink: { status: "confirmed", source: "Payment that created this package" },
      addOns: addOns.filter((a) => a.targetEntitlementId === e.id).map((a) => payment(a, traced)),
      // Time-ups bought on the same phone extend this package in place but the
      // record doesn't name the package, so they stay unattributed here.
      topUpsNote: "Top-ups that extended this package aren't linked to it in records (unresolved)."
    }))
  };
}
