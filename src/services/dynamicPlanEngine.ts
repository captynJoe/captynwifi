import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { formatMikrotikRateLimit, parseMikrotikRateLimit } from "./rateLimit.js";

type Tier = "QUIET" | "GREEN" | "YELLOW" | "RED" | "CRITICAL";

type TierMultiplier = {
  price: number;
  rate: number;
  duration: number;
  published: boolean;
};

type BaselinePlan = {
  id: string;
  name: string;
  durationSeconds: number;
  priceKsh: number;
  rateLimit: string | null;
  category: string;
  deviceLimit: number;
};

type ScaledSpec = {
  name: string;
  durationSeconds: number;
  priceKsh: number;
  rateLimit: string | null;
  category: string;
  deviceLimit: number;
  enabled: boolean;
};

// Multipliers applied to each baseline (captyn_admin) plan's own price/speed/
// duration -- the whole menu moves together with traffic instead of one
// synthetic outlier plan. Adjust freely; these are the only numbers that
// encode the pricing/speed policy.
export const TIER_MULTIPLIERS: Record<Tier, TierMultiplier> = {
  QUIET: { price: 0.7, rate: 1.4, duration: 1.25, published: true },
  GREEN: { price: 1.0, rate: 1.0, duration: 1.0, published: true },
  YELLOW: { price: 1.15, rate: 0.85, duration: 0.85, published: true },
  RED: { price: 1.35, rate: 0.65, duration: 0.65, published: true },
  CRITICAL: { price: 1.35, rate: 0.65, duration: 0.65, published: false }
};

export function tierForUtilization(avgUtilizationScore: number): Tier {
  if (avgUtilizationScore >= 0.95) return "CRITICAL";
  if (avgUtilizationScore >= 0.8) return "RED";
  if (avgUtilizationScore >= 0.5) return "YELLOW";
  if (avgUtilizationScore >= 0.25) return "GREEN";
  return "QUIET";
}

function scalePrice(priceKsh: number, multiplier: number): number {
  return Math.max(1, Math.round(priceKsh * multiplier));
}

function scaleDuration(durationSeconds: number, multiplier: number): number {
  const scaled = Math.round((durationSeconds * multiplier) / 60) * 60;
  return Math.max(300, scaled);
}

function scaleRateLimit(rateLimit: string | null, multiplier: number): string | null {
  const parsed = parseMikrotikRateLimit(rateLimit);
  if (!parsed) return rateLimit;
  return formatMikrotikRateLimit({
    uploadBps: parsed.uploadBps * multiplier,
    downloadBps: parsed.downloadBps * multiplier
  });
}

// Day-plus plans (daily/weekly/monthly) keep their advertised duration fixed
// -- flexing a 30-day plan's duration by the same +/-25-35% multiplier used
// for hourly plans produces nonsense like "900 hours" instead of "30 days".
// Only price/speed flex for these; only sub-day plans flex duration too.
const DURATION_SCALE_MAX_BASELINE_SECONDS = 86400;

// Idle bandwidth is perishable -- unsold Mbps this evening can't be sold
// tomorrow, so an hourly walk-up customer should feel the full swing of
// current conditions. A 30-day customer is reserving a month of future
// capacity that today's quiet network says nothing about; discounting (or
// surging) their price by the same 30-35% as an hourly plan sells that
// future capacity too cheaply (or breaks the predictability long-term
// customers are actually paying for). Intensity scales how much of a
// tier's full price/rate/duration swing actually applies, tapering toward
// zero as the baseline commitment length grows. Duration bonuses are
// already frozen entirely above 24h (see DURATION_SCALE_MAX_BASELINE_SECONDS);
// intensity only tapers duration *within* the sub-24h range, toward that cutoff.
type DurationBucket = "FULL" | "STRONG" | "MILD" | "SMALL" | "MINIMAL";

function durationBucketFor(baselineDurationSeconds: number): DurationBucket {
  if (baselineDurationSeconds <= 8 * 3600) return "FULL"; // walk-up: up to 8h
  if (baselineDurationSeconds <= 86400) return "STRONG"; // 8-24h
  if (baselineDurationSeconds <= 3 * 86400) return "MILD"; // 2-3 days
  if (baselineDurationSeconds <= 7 * 86400) return "SMALL"; // up to a week
  return "MINIMAL"; // monthly-scale commitments
}

const BUCKET_INTENSITY: Record<DurationBucket, { price: number; rate: number; duration: number }> = {
  FULL: { price: 1, rate: 1, duration: 1 },
  STRONG: { price: 0.6, rate: 0.6, duration: 0.5 },
  MILD: { price: 0.3, rate: 0.35, duration: 0 },
  SMALL: { price: 0.15, rate: 0.3, duration: 0 },
  MINIMAL: { price: 0, rate: 0.2, duration: 0 }
};

function dampen(multiplier: number, intensity: number): number {
  return 1 + intensity * (multiplier - 1);
}

// Every plan has a family, inferred from its name (no admin field -- kept
// automatic on purpose). Each family owns exactly one primary value axis;
// every other axis is locked at baseline. Without this, a single QUIET
// rotation could discount the price, extend the duration, *and* boost the
// speed of the same short plan all at once -- three unrelated gifts
// stacked on one purchase instead of one coherent offer. Only matters for
// FULL/STRONG duration buckets (<=24h); MILD/SMALL/MINIMAL buckets ignore
// family entirely and keep the existing duration-only decay, which already
// lands close to "speed-biased, price-muted" naturally as duration grows.
export type Family = "everyday" | "fast" | "gulfstream" | "flash" | "occasion";

export function classifyFamily(name: string): Family {
  const n = name.toLowerCase();
  if (n.includes("gulfstream")) return "gulfstream";
  if (n.includes("highspeed")) return "fast";
  if (n.includes("epl")) return "occasion"; // match-day plans: no dynamic movement at all
  if (n.includes("flash")) return "flash";
  return "everyday"; // Cruise/Basic/Go/8 Balls/Standard/etc. -- the default
}

// FULL-bucket (<=8h) ceiling intensity per family/tier. STRONG bucket
// (8-24h) further dampens this by BUCKET_INTENSITY.STRONG, same as the
// rest of the duration-decay system.
function familyAxisIntensity(family: Family, tier: Tier): { price: number; rate: number; duration: number } {
  switch (family) {
    case "flash":
      return { price: 1, rate: 0.15, duration: 0 };
    case "fast":
      return { price: 0.1, rate: 1, duration: 0 };
    case "gulfstream":
      return { price: 0, rate: 1.3, duration: 0 };
    case "occasion":
      return { price: 0, rate: 0, duration: 0 };
    case "everyday":
    default:
      // Duration is still everyday's primary QUIET axis, but a handful of
      // baseline plans (Basic Hour, 3/6 HR Go, Basic Day) sit at exactly
      // 5Mbps download -- the portal's red/"speed-starter" cutoff -- so
      // duration-only movement leaves them looking slow on a screen even
      // when the network is sitting idle with capacity to spare. A modest
      // secondary rate intensity (well below flash/fast/gulfstream's) lifts
      // every current baseline clear of that cutoff during QUIET specifically,
      // without erasing the speed gap to the families that lean on rate as
      // their primary axis.
      if (tier === "QUIET") return { price: 0, rate: 0.5, duration: 1 };
      if (tier === "YELLOW" || tier === "RED" || tier === "CRITICAL") return { price: 1, rate: 0, duration: 0 };
      return { price: 0, rate: 0, duration: 0 }; // GREEN: no movement either way
  }
}

export function scaleBaselinePlan(baseline: BaselinePlan, tier: Tier): ScaledSpec {
  const multiplier = TIER_MULTIPLIERS[tier];
  const bucket = durationBucketFor(baseline.durationSeconds);

  let intensity: { price: number; rate: number; duration: number };
  if (bucket === "FULL" || bucket === "STRONG") {
    const primary = familyAxisIntensity(classifyFamily(baseline.name), tier);
    const damp = BUCKET_INTENSITY[bucket];
    intensity = { price: primary.price * damp.price, rate: primary.rate * damp.rate, duration: primary.duration * damp.duration };
  } else {
    intensity = BUCKET_INTENSITY[bucket];
  }

  const durationMultiplier =
    baseline.durationSeconds >= DURATION_SCALE_MAX_BASELINE_SECONDS ? 1 : dampen(multiplier.duration, intensity.duration);
  return {
    name: baseline.name,
    durationSeconds: scaleDuration(baseline.durationSeconds, durationMultiplier),
    priceKsh: scalePrice(baseline.priceKsh, dampen(multiplier.price, intensity.price)),
    rateLimit: scaleRateLimit(baseline.rateLimit, dampen(multiplier.rate, intensity.rate)),
    category: baseline.category,
    deviceLimit: baseline.deviceLimit,
    enabled: multiplier.published
  };
}

export const DYNAMIC_PLAN_SOURCE = "captyn_dynamic";

export class DynamicPlanEngine {
  private samples: number[] = [];
  private windowStartedAt = Date.now();

  recordSample(utilizationScore: number) {
    this.samples.push(utilizationScore);
  }

  async maybeRotate() {
    const now = Date.now();
    const windowElapsed = now - this.windowStartedAt >= config.dynamicPlan.rotationMs;

    if (!windowElapsed) {
      if (this.samples.length === 0) return;
      // Dry run never writes mirrors, so "no mirrors yet" is permanently
      // true there and not a meaningful bootstrap signal -- always wait out
      // the full window in dry run.
      if (config.dynamicPlan.dryRun) return;

      // Bootstrap: on first-ever activation, or any wifi_governor restart
      // before the first rotation completed, don't leave the storefront's
      // paid plans hidden (see public.ts's /sites listing) for up to a full
      // rotation window -- rotate immediately once real samples exist.
      const hasMirrors = await prisma.wifiPlan.findFirst({ where: { source: DYNAMIC_PLAN_SOURCE }, select: { id: true } });
      if (hasMirrors) return;
    }

    const windowStartsAt = new Date(this.windowStartedAt);
    const windowEndsAt = new Date(now);
    const sampleCount = this.samples.length;
    const avgUtilizationScore = sampleCount > 0 ? this.samples.reduce((sum, value) => sum + value, 0) / sampleCount : 0;
    const tier = tierForUtilization(avgUtilizationScore);
    const published = TIER_MULTIPLIERS[tier].published;

    this.samples = [];
    this.windowStartedAt = now;

    const sites = await prisma.wifiSite.findMany({ select: { id: true } });
    let totalMirrored = 0;

    for (const site of sites) {
      // Only paid, enabled baseline plans get a dynamic mirror -- free/
      // promotional plans (e.g. CAPTYN Welcome) stay on captyn_admin
      // untouched, since /access/free depends on them staying there.
      // manualPricing plans are also excluded -- the admin pinned that
      // price on purpose, and mirroring it would immediately re-flex it
      // with the tier multiplier, defeating the whole point.
      const baselines = await prisma.wifiPlan.findMany({
        where: { siteId: site.id, source: "captyn_admin", enabled: true, priceKsh: { gt: 0 }, manualPricing: false },
        select: { id: true, name: true, durationSeconds: true, priceKsh: true, rateLimit: true, category: true, deviceLimit: true }
      });

      for (const baseline of baselines) {
        const spec = scaleBaselinePlan(baseline, tier);

        if (!config.dynamicPlan.dryRun) {
          await prisma.wifiPlan.upsert({
            where: {
              siteId_source_externalPackageId: {
                siteId: site.id,
                source: DYNAMIC_PLAN_SOURCE,
                externalPackageId: baseline.id
              }
            },
            create: {
              siteId: site.id,
              source: DYNAMIC_PLAN_SOURCE,
              externalPackageId: baseline.id,
              ...spec
            },
            update: spec
          });
        }

        totalMirrored += 1;
      }

      // manualPricing plans skip the mirror loop above entirely, so they'd
      // otherwise keep selling straight through CRITICAL-tier congestion --
      // the same condition that hides every other paid plan network-wide
      // (see TIER_MULTIPLIERS.CRITICAL.published). One-directional on
      // purpose: only ever flips enabled -> false here, never back to true,
      // since there's no way to tell "disabled by this kill switch" apart
      // from "admin disabled it for their own reason" -- auto-flipping it
      // back on would silently override that. Re-enabling after congestion
      // clears is a deliberate admin action, not automatic. Never touches
      // price/rate/duration -- a kill switch, not a repricing.
      if (!config.dynamicPlan.dryRun && tier === "CRITICAL") {
        await prisma.wifiPlan.updateMany({
          where: { siteId: site.id, source: "captyn_admin", manualPricing: true, enabled: true },
          data: { enabled: false }
        });
      }

      await prisma.wifiDynamicPlanEvent.create({
        data: {
          siteId: site.id,
          state: tier,
          dryRun: config.dynamicPlan.dryRun,
          avgUtilizationScore,
          sampleCount,
          windowStartsAt,
          windowEndsAt,
          published: !config.dynamicPlan.dryRun && published
        }
      });
    }

    console.log(
      `[DynamicPlanEngine] tier=${tier} avgUtil=${avgUtilizationScore.toFixed(2)} samples=${sampleCount} sites=${sites.length} mirrored=${totalMirrored} dryRun=${config.dynamicPlan.dryRun}`
    );
  }
}
