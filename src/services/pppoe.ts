import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { applyRadiusProjectionRows } from "./radiusSqlApply.js";
import { createRadiusSecret, normalizeWifiUsername } from "./radiusProjection.js";

const MIN_MONTH_SECONDS = 28 * 24 * 60 * 60;

type PaymentWithPlan = Prisma.WifiPaymentIntentGetPayload<{ include: { plan: true; site: true } }>;

export async function activatePppoePayment(
  tx: Prisma.TransactionClient,
  payment: PaymentWithPlan,
  confirmedAt: Date
) {
  if (payment.accessType !== "pppoe") throw new Error("Payment is not a PPPoE purchase");
  if (!payment.plan.pppoeEnabled || payment.plan.durationSeconds < MIN_MONTH_SECONDS || payment.amountKsh <= 0 || !payment.plan.rateLimit) {
    throw new Error("PPPoE purchases require an enabled, speed-limited paid monthly plan");
  }

  // Serialize renewals for a phone so two successful M-PESA prompts cannot
  // race and overwrite the same RADIUS credentials or lose a month of time.
  const lockKey = `pppoe:${payment.siteId}:${payment.customerPhone}`;
  await tx.$queryRaw(Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${lockKey}))`);

  const alreadyApplied = await tx.wifiPppoeSubscription.findUnique({
    where: { paymentIntentId: payment.id },
    include: { account: true }
  });
  if (alreadyApplied) {
    const intent = await tx.wifiPaymentIntent.update({
      where: { id: payment.id },
      data: { status: "activated", confirmedAt: payment.confirmedAt ?? confirmedAt }
    });
    return { intent, account: alreadyApplied.account, subscription: alreadyApplied, alreadyProcessed: true, entitlement: null, projection: null, extended: false };
  }

  const existing = await tx.wifiPppoeAccount.findUnique({
    where: { siteId_customerPhone: { siteId: payment.siteId, customerPhone: payment.customerPhone } }
  });
  const startsAt = existing?.status === "active" && existing.expiresAt > confirmedAt
    ? existing.expiresAt
    : confirmedAt;
  const expiresAt = new Date(startsAt.getTime() + payment.plan.durationSeconds * 1000);
  const username = existing?.username ?? `ppp${normalizeWifiUsername(payment.customerPhone)}`;
  const password = existing?.cleartextSecret ?? createRadiusSecret();
  const rateLimit = payment.plan.rateLimit;

  const account = existing
    ? await tx.wifiPppoeAccount.update({
        where: { id: existing.id },
        data: { planId: payment.planId, status: "active", startsAt, expiresAt, rateLimit }
      })
    : await tx.wifiPppoeAccount.create({
        data: {
          siteId: payment.siteId,
          planId: payment.planId,
          customerPhone: payment.customerPhone,
          username,
          cleartextSecret: password,
          status: "active",
          startsAt,
          expiresAt,
          rateLimit
        }
      });

  const seconds = Math.max(60, Math.ceil((expiresAt.getTime() - confirmedAt.getTime()) / 1000));
  const checkItems = [
    { attribute: "User-Name", op: ":=", value: account.username },
    { attribute: "Cleartext-Password", op: ":=", value: account.cleartextSecret },
    { attribute: "Simultaneous-Use", op: ":=", value: 1 }
  ];
  const replyItems = [
    ...(rateLimit ? [{ attribute: "Mikrotik-Rate-Limit", op: ":=", value: rateLimit }] : []),
    { attribute: "Session-Timeout", op: ":=", value: seconds },
    { attribute: "Acct-Interim-Interval", op: ":=", value: config.defaultAcctInterimSeconds },
    { attribute: "Service-Type", op: ":=", value: "Framed-User" },
    { attribute: "Framed-Protocol", op: ":=", value: "PPP" },
    { attribute: "Class", op: ":=", value: `pppoe:${account.id}` }
  ];
  await applyRadiusProjectionRows(tx, account.username, checkItems, replyItems);

  const subscription = await tx.wifiPppoeSubscription.create({
    data: {
      accountId: account.id,
      paymentIntentId: payment.id,
      planId: payment.planId,
      amountKsh: payment.amountKsh,
      startsAt,
      expiresAt
    }
  });
  const intent = await tx.wifiPaymentIntent.update({
    where: { id: payment.id },
    data: { status: "activated", confirmedAt: payment.confirmedAt ?? confirmedAt }
  });

  return { intent, account, subscription, alreadyProcessed: false, entitlement: null, projection: null, extended: false };
}

export function publicPppoeAccount(account: {
  username: string;
  cleartextSecret: string;
  startsAt: Date;
  expiresAt: Date;
  rateLimit: string | null;
}, planName?: string) {
  return {
    username: account.username,
    password: account.cleartextSecret,
    startsAt: account.startsAt,
    expiresAt: account.expiresAt,
    rateLimit: account.rateLimit,
    planName: planName ?? null
  };
}
