import type { PrismaClient } from "@prisma/client";
import { formatCreditDuration, grantWifiCredit } from "./credits.js";

// Payments taken but never applied: their activation job is parked in
// manual_review. Admin Payments → Needs attention lists them so the owner can
// credit the customer (with a message saying which payment it's for) or close
// them after sorting it another way -- instead of issuing vouchers by hand.

export type Actor = { id: string; name: string | null };

// Why it failed, in plain words, from the activation job's last error.
export function describeFailure(lastError: string | null): string {
  const e = (lastError ?? "").toLowerCase();
  if (e.includes("already been upgraded")) return "The package had already been upgraded this term, so it couldn't be applied.";
  if (e.includes("expired") || e.includes("no longer active") || e.includes("no active")) return "The package it was for had ended before the payment arrived.";
  if (e.includes("device limit") || e.includes("devices")) return "The package was already at its device limit.";
  if (!e) return "It couldn't be applied automatically.";
  return (lastError ?? "").split(" | ")[0].slice(0, 200);
}

export function purposeLabel(purpose: string | null): string {
  if (purpose === "add_device") return "Add a device";
  if (purpose === "package_upgrade") return "Upgrade";
  return "New package";
}

// Pure: what to credit by default. An add-device/upgrade is worth the time
// the package still had when they paid; a new package is worth its length.
export function defaultCreditHours(input: {
  purpose: string | null; paidAt: Date; planSeconds: number | null; targetExpiresAt: Date | null;
}): number {
  const planHours = input.planSeconds ? input.planSeconds / 3600 : 1;
  let hours = planHours;
  if ((input.purpose === "add_device" || input.purpose === "package_upgrade") && input.targetExpiresAt) {
    hours = Math.min(planHours, Math.max(0, (input.targetExpiresAt.getTime() - input.paidAt.getTime()) / 3600000));
  }
  return Math.max(1, Math.round(hours * 2) / 2);
}

const dayLabel = (d: Date) => new Date(d.getTime() + 3 * 3600 * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function defaultCreditText(input: { amountKsh: number; paidAt: Date; receipt: string | null; purpose: string | null; hours: number }) {
  const day = dayLabel(input.paidAt);
  const what = input.purpose === "add_device" ? " to add a device" : input.purpose === "package_upgrade" ? " for an upgrade" : "";
  return {
    title: `For your ${day} payment`,
    message: `Sorry: your KSh ${input.amountKsh} on ${day}${input.receipt ? ` (M-PESA ${input.receipt})` : ""}${what} didn't go through. Here's ${formatCreditDuration(Math.round(input.hours * 3600))} of free WiFi for it. Tap Activate when you want it to start.`
  };
}

export async function listUnappliedPayments(prisma: PrismaClient) {
  const jobs = await prisma.wifiPaymentActivationJob.findMany({
    where: { status: "manual_review" },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { paymentIntent: { include: { plan: { select: { name: true, durationSeconds: true } } } } }
  });
  const targetIds = jobs.map((j) => j.paymentIntent.targetEntitlementId).filter((id): id is string => Boolean(id));
  const targets = targetIds.length
    ? await prisma.wifiEntitlement.findMany({ where: { id: { in: targetIds } }, select: { id: true, expiresAt: true, plan: { select: { name: true } } } })
    : [];
  const targetById = new Map(targets.map((t) => [t.id, t]));
  return jobs.map((job) => {
    const intent = job.paymentIntent;
    const target = intent.targetEntitlementId ? targetById.get(intent.targetEntitlementId) : undefined;
    const hours = defaultCreditHours({ purpose: intent.purpose, paidAt: intent.createdAt, planSeconds: intent.plan?.durationSeconds ?? null, targetExpiresAt: target?.expiresAt ?? null });
    return {
      paymentIntentId: intent.id,
      paidAt: intent.createdAt,
      phone: intent.customerPhone,
      amountKsh: intent.amountKsh,
      receipt: intent.receiptNumber,
      purpose: purposeLabel(intent.purpose),
      packageName: intent.plan?.name ?? null,
      forPackage: target?.plan?.name ?? null,
      reason: describeFailure(job.lastError),
      attempts: job.attempts,
      suggested: { hours, ...defaultCreditText({ amountKsh: intent.amountKsh, paidAt: intent.createdAt, receipt: intent.receiptNumber, purpose: intent.purpose, hours }) }
    };
  });
}

async function openJob(prisma: PrismaClient, paymentIntentId: string) {
  const job = await prisma.wifiPaymentActivationJob.findUnique({ where: { paymentIntentId }, include: { paymentIntent: true } });
  if (!job || job.status !== "manual_review") throw Object.assign(new Error("This payment no longer needs attention."), { status: 409 });
  return job;
}

export async function creditUnappliedPayment(
  prisma: PrismaClient, paymentIntentId: string,
  input: { hours: number; title: string; message: string; actor: Actor }
) {
  const job = await openJob(prisma, paymentIntentId);
  const intent = job.paymentIntent;
  const durationSeconds = Math.round(input.hours * 3600);
  const credit = await grantWifiCredit(prisma, {
    customerPhone: intent.customerPhone,
    durationSeconds,
    reason: "SERVICE_RECOVERY",
    sourceReference: `unapplied-payment:${intent.id}`,
    expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
    createdBy: input.actor.name ?? input.actor.id,
    metadata: { title: input.title, message: input.message, paymentIntentId: intent.id }
  });
  const note = `Credited ${formatCreditDuration(durationSeconds)} by ${input.actor.name ?? input.actor.id}`;
  await prisma.$transaction([
    prisma.wifiPaymentActivationJob.update({
      where: { paymentIntentId }, data: { status: "completed", completedAt: new Date(), lastError: `${job.lastError ?? ""} | ${note}`.slice(0, 1000) }
    }),
    prisma.wifiAuditEvent.create({
      data: { actorId: input.actor.id, actorName: input.actor.name, action: "payment.unapplied.credited", target: intent.id, detail: { creditId: credit.id, hours: input.hours, title: input.title, message: input.message } }
    })
  ]);
  return { creditId: credit.id };
}

export async function closeUnappliedPayment(prisma: PrismaClient, paymentIntentId: string, input: { note: string; actor: Actor }) {
  const job = await openJob(prisma, paymentIntentId);
  await prisma.$transaction([
    prisma.wifiPaymentActivationJob.update({
      where: { paymentIntentId }, data: { status: "completed", completedAt: new Date(), lastError: `${job.lastError ?? ""} | Closed by ${input.actor.name ?? input.actor.id}: ${input.note}`.slice(0, 1000) }
    }),
    prisma.wifiAuditEvent.create({
      data: { actorId: input.actor.id, actorName: input.actor.name, action: "payment.unapplied.closed", target: paymentIntentId, detail: { note: input.note } }
    })
  ]);
}
