import { config } from "../config.js";
import { prisma } from "../prisma.js";

type Tier = "QUIET" | "GREEN" | "YELLOW" | "RED" | "CRITICAL";

type TierSpec = {
  name: string;
  durationSeconds: number;
  priceKsh: number;
  rateLimit: string;
  published: boolean;
};

// Anchored on "Cruise Hour" (1h / KSh 10 / 7M-12M), the closest existing
// admin plan to the 1h rotation window. Adjust freely -- these are the only
// numbers that encode the pricing/speed policy.
export const TIER_SPECS: Record<Tier, TierSpec> = {
  QUIET: { name: "Off-Peak Flash", durationSeconds: 90 * 60, priceKsh: 7, rateLimit: "10M/16M", published: true },
  GREEN: { name: "Hourly Flash", durationSeconds: 60 * 60, priceKsh: 10, rateLimit: "7M/12M", published: true },
  YELLOW: { name: "Hourly Flash", durationSeconds: 45 * 60, priceKsh: 12, rateLimit: "6M/10M", published: true },
  RED: { name: "Peak Flash", durationSeconds: 30 * 60, priceKsh: 15, rateLimit: "4M/7M", published: true },
  CRITICAL: { name: "Peak Flash", durationSeconds: 30 * 60, priceKsh: 15, rateLimit: "4M/7M", published: false }
};

export function tierForUtilization(avgUtilizationScore: number): Tier {
  if (avgUtilizationScore >= 0.95) return "CRITICAL";
  if (avgUtilizationScore >= 0.8) return "RED";
  if (avgUtilizationScore >= 0.5) return "YELLOW";
  if (avgUtilizationScore >= 0.25) return "GREEN";
  return "QUIET";
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
    const spec = TIER_SPECS[tier];

    this.samples = [];
    this.windowStartedAt = now;

    const sites = await prisma.wifiSite.findMany({ select: { id: true } });

    for (const site of sites) {
      let planId: string | null = null;

      if (!config.dynamicPlan.dryRun) {
        const plan = await prisma.wifiPlan.upsert({
          where: {
            siteId_source_externalPackageId: {
              siteId: site.id,
              source: DYNAMIC_PLAN_SOURCE,
              externalPackageId: config.dynamicPlan.externalPackageId
            }
          },
          create: {
            siteId: site.id,
            source: DYNAMIC_PLAN_SOURCE,
            externalPackageId: config.dynamicPlan.externalPackageId,
            name: spec.name,
            durationSeconds: spec.durationSeconds,
            priceKsh: spec.priceKsh,
            category: "dynamic",
            rateLimit: spec.rateLimit,
            deviceLimit: 1,
            enabled: spec.published
          },
          update: {
            name: spec.name,
            durationSeconds: spec.durationSeconds,
            priceKsh: spec.priceKsh,
            rateLimit: spec.rateLimit,
            enabled: spec.published
          }
        });
        planId = plan.id;
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
          planId,
          durationSeconds: spec.durationSeconds,
          priceKsh: spec.priceKsh,
          rateLimit: spec.rateLimit,
          published: !config.dynamicPlan.dryRun && spec.published
        }
      });
    }

    console.log(
      `[DynamicPlanEngine] tier=${tier} avgUtil=${avgUtilizationScore.toFixed(2)} samples=${sampleCount} sites=${sites.length} dryRun=${config.dynamicPlan.dryRun}`
    );
  }
}
