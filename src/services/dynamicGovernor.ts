import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { kickHotspotUser } from "./routeros.js";
import { parseMikrotikRateLimit, rateLimitEquals, scaleMikrotikRateLimit } from "./rateLimit.js";

type PressureState = "GREEN" | "YELLOW" | "RED" | "CRITICAL";
type PriorityClass = "welcome" | "standard" | "protected";

type ActiveAccountingRow = {
  acctUniqueId: string;
  username: string;
  inputOctets: bigint | number | null;
  outputOctets: bigint | number | null;
  updatedAt: Date | null;
  entitlementId: string | null;
  rateLimit: string | null;
  planName: string | null;
  priceKsh: number | null;
  category: string | null;
};

type AccountingSample = {
  acctUniqueId: string;
  username: string;
  inputOctets: bigint;
  outputOctets: bigint;
  updatedAt: Date;
  entitlementId: string | null;
  rateLimit: string | null;
  planName: string | null;
  priceKsh: number;
  category: string | null;
};

type ThroughputSample = AccountingSample & {
  uploadBps: number;
  downloadBps: number;
};

type GovernorEventInput = {
  state: PressureState;
  dryRun: boolean;
  activeSessionCount: number;
  activeDemandMbps: number;
  utilizationScore: number;
  username?: string | null;
  entitlementId?: string | null;
  previousRateLimit?: string | null;
  targetRateLimit?: string | null;
  reason: string;
  raw?: Prisma.InputJsonValue;
};

const STATE_FACTORS: Record<PressureState, Record<PriorityClass, number>> = {
  GREEN: { welcome: 1, standard: 1, protected: 1 },
  YELLOW: { welcome: 0.8, standard: 1, protected: 1 },
  RED: { welcome: 0.5, standard: 0.8, protected: 0.9 },
  CRITICAL: { welcome: 0.3, standard: 0.6, protected: 0.75 }
};

function toBigInt(value: bigint | number | null): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return BigInt(Math.round(value));
  return 0n;
}

function toNumber(value: bigint): number {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > maxSafe ? maxSafe : value);
}

function priorityClass(sample: AccountingSample): PriorityClass {
  const name = String(sample.planName || "").toLowerCase();
  const category = String(sample.category || "").toLowerCase();
  if (sample.priceKsh <= 0 || name.includes("welcome")) return "welcome";
  if (category === "limited" || sample.priceKsh <= 20) return "standard";
  return "protected";
}

async function recordGovernorEvent(input: GovernorEventInput) {
  await prisma.$executeRaw`
    INSERT INTO "WifiGovernorEvent" (
      "state",
      "dryRun",
      "activeSessionCount",
      "activeDemandMbps",
      "utilizationScore",
      "username",
      "entitlementId",
      "previousRateLimit",
      "targetRateLimit",
      "reason",
      "raw"
    )
    VALUES (
      ${input.state},
      ${input.dryRun},
      ${input.activeSessionCount},
      ${input.activeDemandMbps},
      ${input.utilizationScore},
      ${input.username ?? null},
      ${input.entitlementId ?? null},
      ${input.previousRateLimit ?? null},
      ${input.targetRateLimit ?? null},
      ${input.reason},
      ${input.raw ?? Prisma.JsonNull}
    )
  `;
}

async function readActiveAccountingRows(): Promise<AccountingSample[]> {
  const rows = await prisma.$queryRaw<ActiveAccountingRow[]>`
    SELECT
      r.acctuniqueid as "acctUniqueId",
      r.username as "username",
      coalesce(r.acctinputoctets, 0) as "inputOctets",
      coalesce(r.acctoutputoctets, 0) as "outputOctets",
      coalesce(r.acctupdatetime, r.acctstarttime) as "updatedAt",
      e.id as "entitlementId",
      e."rateLimit" as "rateLimit",
      p.name as "planName",
      p."priceKsh" as "priceKsh",
      p.category as "category"
    FROM radacct r
    LEFT JOIN "WifiEntitlement" e
      ON e.username = r.username
      AND e.status = 'active'
      AND e."expiresAt" > now()
    LEFT JOIN "WifiPlan" p ON p.id = e."planId"
    WHERE r.acctstoptime IS NULL
      AND r.username IS NOT NULL
      AND coalesce(r.acctupdatetime, r.acctstarttime) >= now() - (${config.governor.activeWindowSeconds} * interval '1 second')
    ORDER BY coalesce(r.acctupdatetime, r.acctstarttime) DESC
  `;

  return rows
    .filter((row) => row.updatedAt && row.username)
    .map((row) => ({
      acctUniqueId: row.acctUniqueId,
      username: row.username,
      inputOctets: toBigInt(row.inputOctets),
      outputOctets: toBigInt(row.outputOctets),
      updatedAt: row.updatedAt as Date,
      entitlementId: row.entitlementId,
      rateLimit: row.rateLimit,
      planName: row.planName,
      priceKsh: row.priceKsh ?? 0,
      category: row.category
    }));
}

async function applyRadiusRateLimit(username: string, rateLimit: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM radreply WHERE username = ${username} AND attribute = 'Mikrotik-Rate-Limit'`;
    await tx.$executeRaw`INSERT INTO radreply (username, attribute, op, value) VALUES (${username}, 'Mikrotik-Rate-Limit', ':=', ${rateLimit})`;
  });
}

function desiredState(utilizationScore: number): PressureState {
  if (utilizationScore >= 0.98) return "CRITICAL";
  if (utilizationScore >= 0.9) return "RED";
  if (utilizationScore >= 0.8) return "YELLOW";
  return "GREEN";
}

function durationForState(state: PressureState): number {
  if (state === "CRITICAL") return config.governor.enterCriticalMs;
  if (state === "RED") return config.governor.enterRedMs;
  if (state === "YELLOW") return config.governor.enterYellowMs;
  return config.governor.recoverMs;
}

export class WifiDynamicGovernor {
  private previousSamples = new Map<string, AccountingSample>();
  private state: PressureState = "GREEN";
  private candidateState: PressureState = "GREEN";
  private candidateSince = Date.now();

  async tick(): Promise<{ utilizationScore: number }> {
    const samples = await readActiveAccountingRows();
    const throughput = this.calculateThroughput(samples);
    const totals = throughput.reduce(
      (acc, sample) => ({
        uploadBps: acc.uploadBps + sample.uploadBps,
        downloadBps: acc.downloadBps + sample.downloadBps
      }),
      { uploadBps: 0, downloadBps: 0 }
    );

    const downloadUtilization = totals.downloadBps / (config.governor.wanDownloadMbps * 1_000_000);
    const uploadUtilization = totals.uploadBps / (config.governor.wanUploadMbps * 1_000_000);
    const utilizationScore = Math.max(downloadUtilization, uploadUtilization, 0);
    const nextState = this.transitionState(desiredState(utilizationScore));
    const activeDemandMbps = totals.downloadBps / 1_000_000;

    await recordGovernorEvent({
      state: nextState,
      dryRun: config.governor.dryRun,
      activeSessionCount: samples.length,
      activeDemandMbps,
      utilizationScore,
      reason: "pressure-sample",
      raw: {
        uploadMbps: totals.uploadBps / 1_000_000,
        downloadMbps: activeDemandMbps,
        configuredWanUploadMbps: config.governor.wanUploadMbps,
        configuredWanDownloadMbps: config.governor.wanDownloadMbps
      }
    });

    for (const sample of samples) {
      await this.applyDecision(sample, nextState, samples.length, activeDemandMbps, utilizationScore);
    }

    this.previousSamples = new Map(samples.map((sample) => [sample.acctUniqueId, sample]));
    console.log(
      `[WifiGovernor] state=${nextState} active=${samples.length} down=${activeDemandMbps.toFixed(2)}Mbps util=${utilizationScore.toFixed(2)} dryRun=${config.governor.dryRun}`
    );

    return { utilizationScore };
  }

  private calculateThroughput(samples: AccountingSample[]): ThroughputSample[] {
    const result: ThroughputSample[] = [];

    for (const sample of samples) {
      const previous = this.previousSamples.get(sample.acctUniqueId);
      if (!previous) {
        result.push({ ...sample, uploadBps: 0, downloadBps: 0 });
        continue;
      }

      const elapsedSeconds = Math.max(1, (sample.updatedAt.getTime() - previous.updatedAt.getTime()) / 1000);
      const inputDelta = sample.inputOctets > previous.inputOctets ? sample.inputOctets - previous.inputOctets : 0n;
      const outputDelta = sample.outputOctets > previous.outputOctets ? sample.outputOctets - previous.outputOctets : 0n;

      result.push({
        ...sample,
        uploadBps: (toNumber(inputDelta) * 8) / elapsedSeconds,
        downloadBps: (toNumber(outputDelta) * 8) / elapsedSeconds
      });
    }

    return result;
  }

  private transitionState(target: PressureState): PressureState {
    const now = Date.now();
    if (target !== this.candidateState) {
      this.candidateState = target;
      this.candidateSince = now;
    }

    if (target === this.state) return this.state;

    const heldMs = now - this.candidateSince;
    if (heldMs >= durationForState(target)) this.state = target;
    return this.state;
  }

  private async applyDecision(
    sample: AccountingSample,
    state: PressureState,
    activeSessionCount: number,
    activeDemandMbps: number,
    utilizationScore: number
  ) {
    if (!sample.rateLimit || !parseMikrotikRateLimit(sample.rateLimit)) return;

    const priority = priorityClass(sample);
    const targetRateLimit = scaleMikrotikRateLimit(sample.rateLimit, STATE_FACTORS[state][priority]);
    if (!targetRateLimit || rateLimitEquals(sample.rateLimit, targetRateLimit)) return;

    const reason = `${state.toLowerCase()}-${priority}`;
    await recordGovernorEvent({
      state,
      dryRun: config.governor.dryRun,
      activeSessionCount,
      activeDemandMbps,
      utilizationScore,
      username: sample.username,
      entitlementId: sample.entitlementId,
      previousRateLimit: sample.rateLimit,
      targetRateLimit,
      reason,
      raw: { planName: sample.planName, priceKsh: sample.priceKsh, category: sample.category }
    });

    if (config.governor.dryRun || !config.governor.applyRadiusSql) return;

    await applyRadiusRateLimit(sample.username, targetRateLimit);
    if (config.governor.kickOnChange) await kickHotspotUser(sample.username);
  }
}
