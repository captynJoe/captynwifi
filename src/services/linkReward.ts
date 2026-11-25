import { Prisma, type PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { grantWifiCredit } from "./credits.js";
import { fetchHousingStanding, housingConfigured, type HousingStanding } from "./housingStanding.js";

// Confirming a Village Inn tenant's phone in My WiFi links it to their house.
// The first link of each tenancy earns 12 hours, as a credit the tenant
// activates on the device they choose -- only if nothing is overdue at that
// moment. Either way the outcome is recorded, so it's decided once.

export const LINK_REWARD_SECONDS = 12 * 3600;
const ACTIVATE_WITHIN_MS = 30 * 24 * 3600 * 1000;

export type LinkRewardResult =
  | { status: "granted"; houseNumber: string; hours: number }
  | { status: "declined_overdue"; houseNumber: string }
  | { status: "already"; houseNumber: string };

// Pure: what the first link of a tenancy earns.
export function linkRewardOutcome(standing: Pick<HousingStanding, "eligible">): "granted" | "declined_overdue" {
  return standing.eligible ? "granted" : "declined_overdue";
}

// Best effort: a failed Housing check never blocks confirming the phone.
export async function rewardHousingLink(prisma: PrismaClient, phone: string): Promise<LinkRewardResult | null> {
  if (!housingConfigured()) return null;
  let standing: HousingStanding;
  try {
    standing = await fetchHousingStanding(config.housing.promoBuildingId, phone);
  } catch (error) {
    console.warn("Link reward: Housing check failed:", error instanceof Error ? error.message : error);
    return null;
  }
  const { houseNumber, tenancyId } = standing;
  if (!houseNumber || !tenancyId) return null;

  const outcome = linkRewardOutcome(standing);
  let reward;
  try {
    reward = await prisma.wifiLinkReward.create({
      data: { tenancyId, buildingId: config.housing.promoBuildingId, houseNumber, phone, outcome }
    });
  } catch (error) {
    // Unique tenancyId: this tenancy has already had its one go.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { status: "already", houseNumber };
    throw error;
  }
  if (outcome === "declined_overdue") return { status: "declined_overdue", houseNumber };

  const credit = await grantWifiCredit(prisma, {
    customerPhone: phone,
    durationSeconds: LINK_REWARD_SECONDS,
    deviceLimit: 1,
    reason: "HOUSING_LINK_REWARD",
    sourceReference: `housing-link:${tenancyId}`,
    expiresAt: new Date(Date.now() + ACTIVATE_WITHIN_MS),
    createdBy: "housing-link"
  });
  await prisma.wifiLinkReward.update({ where: { id: reward.id }, data: { creditId: credit.id } });
  return { status: "granted", houseNumber, hours: LINK_REWARD_SECONDS / 3600 };
}
