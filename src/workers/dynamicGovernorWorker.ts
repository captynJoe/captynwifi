import "dotenv/config";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { WifiDynamicGovernor } from "../services/dynamicGovernor.js";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!config.governor.enabled) {
    console.log("CAPTYN WiFi dynamic governor disabled");
    return;
  }

  console.log(
    `CAPTYN WiFi dynamic governor running dryRun=${config.governor.dryRun} applyRadiusSql=${config.governor.applyRadiusSql} kickOnChange=${config.governor.kickOnChange}`
  );
  const governor = new WifiDynamicGovernor();

  for (;;) {
    try {
      await governor.tick();
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
