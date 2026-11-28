import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";

// Tenants-only promos: CAPTYN Housing owns "is this house in good standing?"
// (nothing overdue, rent or utilities). WiFi links a device to a tenant only
// through a confirmed M-PESA payment phone, never a typed one, and gets back
// yes/no, the house number and a reason, never amounts.

export type HousingStandingReason = "good_standing" | "rent_overdue" | "utilities_overdue" | "not_a_tenant";
export type HousingStanding = { eligible: boolean; reason: HousingStandingReason; houseNumber?: string; tenancyId?: string };

const PHONE_LOOKBACK_DAYS = 60;
const CACHE_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; standing: HousingStanding }>();

export function housingConfigured() {
  return Boolean(config.housing.apiUrl && config.integrationToken);
}

// The phone that most recently paid by M-PESA from this device.
export async function confirmedPhoneForDevice(prisma: PrismaClient, deviceMac: string, now = new Date()) {
  const intent = await prisma.wifiPaymentIntent.findFirst({
    where: {
      deviceMac, provider: "mpesa", status: "activated", amountKsh: { gt: 0 },
      createdAt: { gte: new Date(now.getTime() - PHONE_LOOKBACK_DAYS * 86400 * 1000) }
    },
    orderBy: { createdAt: "desc" },
    select: { customerPhone: true }
  });
  return intent?.customerPhone || null;
}

// Throws when Housing can't be asked; callers say so rather than guess.
export async function fetchHousingStanding(buildingId: string, phone: string): Promise<HousingStanding> {
  if (!housingConfigured()) throw new Error("CAPTYN Housing link is not configured");
  const key = `${buildingId}|${phone}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.standing;
  const response = await fetch(`${config.housing.apiUrl}/api/internal/wifi/house-standing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-captyn-wifi-token": config.integrationToken },
    body: JSON.stringify({ buildingId, phone }),
    signal: AbortSignal.timeout(6000)
  });
  const payload = await response.json().catch(() => ({})) as { data?: HousingStanding; error?: string };
  if (!response.ok || !payload.data) throw new Error(`CAPTYN Housing ${response.status}: ${payload.error ?? "no answer"}`);
  // Only a yes is remembered: a tenant who has just paid what was overdue
  // must be let in on the very next try, not after the cache runs out.
  if (payload.data.eligible) cache.set(key, { at: Date.now(), standing: payload.data });
  else cache.delete(key);
  return payload.data;
}

export type PromoGate =
  | { allowed: true; houseNumber?: string }
  | { allowed: false; code: "no_phone" | HousingStandingReason | "housing_unavailable"; message: string };

// What the customer is told when a tenants-only promo turns them away.
export function promoGateResult(buildingName: string, phone: string | null, standing: HousingStanding | null, unavailable = false): PromoGate {
  if (!phone) {
    // The CAPTYN Housing app's "Get free WiFi" code proves who they are (no
    // SMS needed); entering it here links this device and claims the offer.
    return { allowed: false, code: "no_phone", message: `This offer is for ${buildingName} tenants. In the CAPTYN Housing app, tap Get free WiFi, then enter the code here.` };
  }
  if (unavailable || !standing) {
    return { allowed: false, code: "housing_unavailable", message: `We couldn't check your ${buildingName} account just now. Try again in a minute.` };
  }
  if (standing.eligible) return { allowed: true, houseNumber: standing.houseNumber };
  const house = standing.houseNumber ? `House ${standing.houseNumber}` : "Your house";
  if (standing.reason === "rent_overdue") {
    return { allowed: false, code: "rent_overdue", message: `${house} has overdue rent. Once it's cleared, this offer unlocks.` };
  }
  if (standing.reason === "utilities_overdue") {
    return { allowed: false, code: "utilities_overdue", message: `${house} has an overdue utility bill. Once it's cleared, this offer unlocks.` };
  }
  return { allowed: false, code: "not_a_tenant", message: `This offer is for ${buildingName} tenants. Your M-PESA number isn't on a ${buildingName} tenancy.` };
}
