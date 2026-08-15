import "dotenv/config";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { WifiDynamicGovernor } from "../services/dynamicGovernor.js";
import { DynamicPlanEngine } from "../services/dynamicPlanEngine.js";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!config.governor.enabled && !config.dynamicPlan.enabled) {
    console.log("CAPTYN WiFi dynamic governor and dynamic plan engine both disabled");
    return;
  }

  console.log(
    `CAPTYN WiFi dynamic governor running dryRun=${config.governor.dryRun} applyRadiusSql=${config.governor.applyRadiusSql} kickOnChange=${config.governor.kickOnChange}`
  );
  if (config.dynamicPlan.enabled) {
    console.log(
      `CAPTYN WiFi dynamic plan engine running dryRun=${config.dynamicPlan.dryRun} rotationMs=${config.dynamicPlan.rotationMs}`
    );
  }
  const governor = new WifiDynamicGovernor();
  const dynamicPlanEngine = new DynamicPlanEngine();

  for (;;) {
    try {
      const { utilizationScore } = await governor.tick();
      if (config.dynamicPlan.enabled) {
        dynamicPlanEngine.recordSample(utilizationScore);
        await dynamicPlanEngine.maybeRotate();
      }
    } catch (error) {
      console.error("CAPTYN WiFi dynamic governor error:", error);
    }
    await sleep(config.governor.pollIntervalMs);
  }
}

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

void main();
