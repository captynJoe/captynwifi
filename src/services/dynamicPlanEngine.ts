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

export function scaleBaselinePlan(baseline: BaselinePlan, tier: Tier): ScaledSpec {
  const multiplier = TIER_MULTIPLIERS[tier];
  return {
    name: baseline.name,
    durationSeconds: scaleDuration(baseline.durationSeconds, multiplier.duration),
    priceKsh: scalePrice(baseline.priceKsh, multiplier.price),
    rateLimit: scaleRateLimit(baseline.rateLimit, multiplier.rate),
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
    if (now - this.windowStartedAt < config.dynamicPlan.rotationMs) return;

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
      const baselines = await prisma.wifiPlan.findMany({
        where: { siteId: site.id, source: "captyn_admin", enabled: true, priceKsh: { gt: 0 } },
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
