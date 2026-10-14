import type { Prisma, PrismaClient, WifiLoyaltyRound, WifiLoyaltySetting } from "@prisma/client";

// Weekly rewards for regulars. Points are a calendar-month score (Nairobi
// time) that resets on the 1st and is never spent: 70 for what a customer
// spent against the month's top spender, 30 for how regularly they paid
// against the most regular. Every Sunday the ranking is frozen into tiers;
// on a random daytime moment that week each ranked customer gets a reward
// and picks one card: free time, or a suggested package with bonus time
// and a speed boost.

export const LOYALTY_REASON = "LOYALTY_REWARD";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NAIROBI_OFFSET_MS = 3 * HOUR_MS; // UTC+3, no daylight saving
// Recent paid days count more: a day's weight halves every two weeks.
const HALF_LIFE_DAYS = 14;
export const SPEND_WEIGHT = 70;
const REGULARITY_WEIGHT = 30;
const RELEASE_FROM_HOUR = 8;
const RELEASE_TO_HOUR = 20;
// Sundays this early in a month reward last month's final ranking, since
// this month's points have barely started.
const NEW_MONTH_GRACE_DAYS = 7;
const OFFER_COUNT = 3;
const PURCHASABLE_PLAN_WHERE: Prisma.WifiPlanWhereInput = {
  enabled: true,
  priceKsh: { gt: 0 },
  OR: [{ source: "captyn_dynamic" }, { source: "captyn_admin", manualPricing: true }]
};

export type LoyaltyTier = { name: string; maxRank: number; freeHours: number; bonusHours: number; speedBoostPct: number };
export const DEFAULT_TIERS: LoyaltyTier[] = [
  { name: "Gold", maxRank: 5, freeHours: 12, bonusHours: 3, speedBoostPct: 50 },
  { name: "Silver", maxRank: 15, freeHours: 6, bonusHours: 2, speedBoostPct: 25 },
  { name: "Bronze", maxRank: 30, freeHours: 3, bonusHours: 1, speedBoostPct: 0 }
];

export type LoyaltyPayment = { phone: string; amountKsh: number; createdAt: Date; deviceMac: string | null };
export type RankedCustomer = { phone: string; deviceMac: string | null; paidDays: number; spentKsh: number; score: number };

function nairobiLocal(at: Date): Date {
  return new Date(at.getTime() + NAIROBI_OFFSET_MS);
}

function nairobiDayKey(at: Date): string {
  return nairobiLocal(at).toISOString().slice(0, 10);
}

// Midnight starting the Nairobi Sunday of `now`'s week, as a UTC instant.
export function nairobiWeekStart(now: Date): Date {
  const local = nairobiLocal(now);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(localMidnight - local.getUTCDay() * DAY_MS - NAIROBI_OFFSET_MS);
}

export function isNairobiSunday(now: Date): boolean {
  return nairobiLocal(now).getUTCDay() === 0;
}

// Midnight on the 1st of the Nairobi month `monthsBack` before `now`'s.
export function nairobiMonthStart(now: Date, monthsBack = 0): Date {
  const local = nairobiLocal(now);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - monthsBack, 1) - NAIROBI_OFFSET_MS);
}

export function monthKey(monthStart: Date): string {
  return nairobiLocal(monthStart).toISOString().slice(0, 7);
}

// The points month a Sunday's pick uses: this month, or last month's final
// ranking in the first week of a month.
export function pickWindow(now: Date): { from: Date; to: Date; month: string } {
  const thisMonth = nairobiMonthStart(now);
  if (nairobiLocal(now).getUTCDate() <= NEW_MONTH_GRACE_DAYS) {
    const lastMonth = nairobiMonthStart(now, 1);
    return { from: lastMonth, to: thisMonth, month: monthKey(lastMonth) };
  }
  return { from: thisMonth, to: now, month: monthKey(thisMonth) };
}

export function normalizeTiers(raw: unknown): LoyaltyTier[] {
  if (!Array.isArray(raw)) return DEFAULT_TIERS;
  const tiers = raw
    .map((tier) => ({
      name: String(tier?.name ?? "").trim().slice(0, 24),
      maxRank: Math.floor(Number(tier?.maxRank)),
      freeHours: Math.max(0, Math.floor(Number(tier?.freeHours) || 0)),
      bonusHours: Math.max(0, Math.floor(Number(tier?.bonusHours) || 0)),
      speedBoostPct: Math.max(0, Math.min(200, Math.floor(Number(tier?.speedBoostPct) || 0)))
    }))
    .filter((tier) => tier.name && tier.maxRank > 0)
    .sort((a, b) => a.maxRank - b.maxRank);
  return tiers.length ? tiers : DEFAULT_TIERS;
}

export function tierForRank(tiers: LoyaltyTier[], rank: number): LoyaltyTier | null {
  return tiers.find((tier) => rank <= tier.maxRank) ?? null;
}

// Ranks customers with at least minPaidDays distinct paid days (so one big
// purchase alone doesn't place) by points out of 100.
export function rankRegulars(payments: LoyaltyPayment[], now: Date, options: { minPaidDays: number }): RankedCustomer[] {
  const byPhone = new Map<string, { days: Set<string>; spentKsh: number; deviceMac: string | null; lastAt: number }>();
  for (const payment of payments) {
    if (payment.amountKsh <= 0) continue;
    const entry = byPhone.get(payment.phone) ?? { days: new Set<string>(), spentKsh: 0, deviceMac: null, lastAt: 0 };
    entry.days.add(nairobiDayKey(payment.createdAt));
    entry.spentKsh += payment.amountKsh;
    if (payment.deviceMac && payment.createdAt.getTime() >= entry.lastAt) {
      entry.deviceMac = payment.deviceMac;
      entry.lastAt = payment.createdAt.getTime();
    }
    byPhone.set(payment.phone, entry);
  }

  const today = Date.parse(`${nairobiDayKey(now)}T00:00:00Z`);
  const qualified: Array<Omit<RankedCustomer, "score"> & { regularity: number }> = [];
  for (const [phone, entry] of byPhone) {
    if (entry.days.size < options.minPaidDays) continue;
    let regularity = 0;
    for (const day of entry.days) {
      const ageDays = Math.max(0, (today - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
      regularity += Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    }
    qualified.push({ phone, deviceMac: entry.deviceMac, paidDays: entry.days.size, spentKsh: entry.spentKsh, regularity });
  }
  const maxSpend = Math.max(1, ...qualified.map((entry) => entry.spentKsh));
  const maxRegularity = Math.max(1e-9, ...qualified.map((entry) => entry.regularity));
  return qualified
    .map(({ regularity, ...entry }) => ({
      ...entry,
      score: Math.round((SPEND_WEIGHT * entry.spentKsh) / maxSpend + (REGULARITY_WEIGHT * regularity) / maxRegularity)
    }))
    .sort((a, b) => b.score - a.score || b.spentKsh - a.spentKsh);
}

// What a customer needs to climb: points to pass the next person (and the
// KSh that roughly buys them, counting only the spend share), and to reach
// the next tier's last place.
export function climbGap(ranked: RankedCustomer[], index: number, targetIndex: number): { points: number; ksh: number | null } | null {
  if (targetIndex < 0 || targetIndex >= index) return null;
  const me = ranked[index];
  const target = ranked[targetIndex];
  const points = Math.max(1, target.score - me.score + 1);
  const maxSpend = Math.max(1, ...ranked.map((entry) => entry.spentKsh));
  const ksh = me.spentKsh < maxSpend ? Math.ceil((points * maxSpend) / SPEND_WEIGHT) : null;
  return { points, ksh };
}

// A random daytime moment (08:00-20:00 Nairobi) on a random day Monday to
// Saturday of the week, never before `now`. Falls back to `now` once the
// week's last window has passed.
export function pickReleaseAt(weekStart: Date, now: Date, random: () => number = Math.random): Date {
  const windows: Array<[number, number]> = [];
  for (let day = 1; day <= 6; day += 1) {
    const dayStart = weekStart.getTime() + day * DAY_MS;
    const from = Math.max(now.getTime(), dayStart + RELEASE_FROM_HOUR * HOUR_MS);
    const to = dayStart + RELEASE_TO_HOUR * HOUR_MS;
    if (to > from) windows.push([from, to]);
  }
  if (!windows.length) return now;
  const [from, to] = windows[Math.min(windows.length - 1, Math.floor(random() * windows.length))];
  return new Date(from + Math.floor(random() * (to - from)));
}

export async function getLoyaltySetting(prisma: PrismaClient): Promise<WifiLoyaltySetting & { tierList: LoyaltyTier[] }> {
  const setting = await prisma.wifiLoyaltySetting.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  return { ...setting, tierList: normalizeTiers(setting.tiers) };
}

async function rankBetween(prisma: PrismaClient, from: Date, to: Date, now: Date, minPaidDays: number): Promise<RankedCustomer[]> {
  const payments = await prisma.wifiPaymentIntent.findMany({
    where: { status: "activated", amountKsh: { gt: 0 }, createdAt: { gte: from, lt: to } },
    select: { customerPhone: true, amountKsh: true, createdAt: true, deviceMac: true }
  });
  return rankRegulars(
    payments.map((payment) => ({ phone: payment.customerPhone, amountKsh: payment.amountKsh, createdAt: payment.createdAt, deviceMac: payment.deviceMac })),
    now,
    { minPaidDays }
  );
}

// This month's live ranking (what customers see).
export async function monthStandings(prisma: PrismaClient, now = new Date()) {
  const setting = await getLoyaltySetting(prisma);
  const from = nairobiMonthStart(now);
  const ranked = await rankBetween(prisma, from, new Date(now.getTime() + 1), now, setting.minPaidDays);
  return { setting, month: monthKey(from), ranked };
}

// Up to three packages a customer is offered as reward cards: what they buy
// most, topped up with what sells most, all currently on sale.
async function suggestedPlanIds(prisma: PrismaClient, phone: string, now: Date): Promise<string[]> {
  const purchasable = await prisma.wifiPlan.findMany({ where: PURCHASABLE_PLAN_WHERE, select: { id: true } });
  const allowed = new Set(purchasable.map((plan) => plan.id));
  const since = new Date(now.getTime() - 60 * DAY_MS);
  const [mine, popular] = await Promise.all([
    prisma.wifiPaymentIntent.groupBy({ by: ["planId"], where: { customerPhone: phone, status: "activated", amountKsh: { gt: 0 }, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.wifiPaymentIntent.groupBy({ by: ["planId"], where: { status: "activated", amountKsh: { gt: 0 }, createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }, _count: { _all: true } })
  ]);
  const order = (rows: Array<{ planId: string; _count: { _all: number } }>) => rows.sort((a, b) => b._count._all - a._count._all).map((row) => row.planId);
  const picked: string[] = [];
  for (const planId of [...order(mine), ...order(popular)]) {
    if (allowed.has(planId) && !picked.includes(planId)) picked.push(planId);
    if (picked.length === OFFER_COUNT) break;
  }
  return picked;
}

// Picks this week's round once; later calls return the existing one.
export async function pickLoyaltyRound(prisma: PrismaClient, now = new Date()): Promise<WifiLoyaltyRound> {
  const weekOf = nairobiWeekStart(now);
  const existing = await prisma.wifiLoyaltyRound.findUnique({ where: { weekOf } });
  if (existing) return existing;
  const setting = await getLoyaltySetting(prisma);
  const window = pickWindow(now);
  const ranked = await rankBetween(prisma, window.from, window.to, now, setting.minPaidDays);
  const lastRank = setting.tierList[setting.tierList.length - 1]?.maxRank ?? 0;
  const rewards: Prisma.WifiLoyaltyRewardCreateWithoutRoundInput[] = [];
  for (const [index, customer] of ranked.slice(0, lastRank).entries()) {
    const tier = tierForRank(setting.tierList, index + 1);
    if (!tier) continue;
    rewards.push({
      customerPhone: customer.phone,
      deviceMac: customer.deviceMac,
      rank: index + 1,
      points: customer.score,
      spentKsh: customer.spentKsh,
      paidDays: customer.paidDays,
      tier: tier.name,
      freeSeconds: tier.freeHours * 3600,
      bonusSeconds: tier.bonusHours * 3600,
      speedBoostPct: tier.speedBoostPct,
      offerPlanIds: await suggestedPlanIds(prisma, customer.phone, now)
    });
  }
  return prisma.wifiLoyaltyRound.create({
    data: { weekOf, month: window.month, releaseAt: pickReleaseAt(weekOf, now), claimDays: setting.claimDays, rewards: { create: rewards } }
  });
}

// Puts a round's rewards out and tells each customer. Retry-safe: only
// rewards still "scheduled" are touched.
export async function releaseLoyaltyRound(prisma: PrismaClient, round: WifiLoyaltyRound, now = new Date()): Promise<number> {
  const expiresAt = new Date(now.getTime() + round.claimDays * DAY_MS);
  const pending = await prisma.wifiLoyaltyReward.findMany({ where: { roundId: round.id, status: "scheduled" } });
  for (const reward of pending) {
    await prisma.$transaction([
      prisma.wifiLoyaltyReward.update({ where: { id: reward.id }, data: { status: "available", expiresAt } }),
      prisma.wifiNotification.create({
        data: {
          customerPhone: reward.customerPhone,
          type: "loyalty_reward",
          title: `${reward.tier} reward · #${reward.rank}`,
          body: "Your weekly reward is here. Open CAPTYN WiFi and pick a card.",
          data: { rewardId: reward.id, tier: reward.tier, rank: reward.rank, expiresAt: expiresAt.toISOString() }
        }
      })
    ]);
  }
  await prisma.wifiLoyaltyRound.update({ where: { id: round.id }, data: { status: "released", releasedAt: now } });
  return pending.length;
}

// Runs from the API's timer: picks on Sundays, releases rounds that are due.
// Nothing happens while rewards are switched off.
export async function runLoyaltyCycle(prisma: PrismaClient, now = new Date()): Promise<{ picked: boolean; released: number }> {
  const setting = await getLoyaltySetting(prisma);
  if (!setting.enabled) return { picked: false, released: 0 };
  let picked = false;
  if (isNairobiSunday(now)) {
    const exists = await prisma.wifiLoyaltyRound.findUnique({ where: { weekOf: nairobiWeekStart(now) } });
    if (!exists) {
      await pickLoyaltyRound(prisma, now);
      picked = true;
    }
  }
  const due = await prisma.wifiLoyaltyRound.findMany({ where: { status: "scheduled", releaseAt: { lte: now } } });
  let released = 0;
  for (const round of due) released += await releaseLoyaltyRound(prisma, round, now);
  return { picked, released };
}

export { PURCHASABLE_PLAN_WHERE };
