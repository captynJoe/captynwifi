import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

export async function enqueuePaymentActivation(tx: Prisma.TransactionClient, paymentIntentId: string) {
  await tx.wifiPaymentActivationJob.createMany({
    data: [{ paymentIntentId }],
    skipDuplicates: true
  });
}

type ClaimedJob = { id: string; paymentIntentId: string; attempts: number };

export async function claimPaymentActivationJobs(limit = 10): Promise<ClaimedJob[]> {
  return prisma.$transaction(async (tx) => {
    // Recover jobs whose worker died after claiming them.
    await tx.wifiPaymentActivationJob.updateMany({
      where: { status: "processing", lockedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
      data: { status: "queued", lockedAt: null, nextAttemptAt: new Date() }
    });
    return tx.$queryRaw<ClaimedJob[]>(Prisma.sql`
      WITH candidates AS (
        SELECT id
        FROM "WifiPaymentActivationJob"
        WHERE status = 'queued'::"WifiPaymentActivationJobStatus"
          AND "nextAttemptAt" <= NOW()
        ORDER BY "nextAttemptAt", "createdAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "WifiPaymentActivationJob" AS job
      SET status = 'processing'::"WifiPaymentActivationJobStatus",
          "lockedAt" = NOW(), "lastAttemptAt" = NOW(),
          attempts = job.attempts + 1, "updatedAt" = NOW()
      FROM candidates
      WHERE job.id = candidates.id
      RETURNING job.id, job."paymentIntentId", job.attempts
    `);
  });
}

export async function completePaymentActivationJob(id: string) {
  await prisma.wifiPaymentActivationJob.updateMany({
    where: { id, status: "processing" },
    data: { status: "completed", lockedAt: null, completedAt: new Date(), lastError: null }
  });
}

export async function markPaymentActivationForManualReview(id: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  await prisma.wifiPaymentActivationJob.updateMany({
    where: { id, status: "processing" },
    data: { status: "manual_review", lockedAt: null, lastError: message }
  });
}

export async function retryPaymentActivationJob(id: string, attempts: number, error: unknown) {
  const delayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 7));
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  await prisma.wifiPaymentActivationJob.updateMany({
    where: { id, status: "processing" },
    data: {
      status: "queued",
      lockedAt: null,
      nextAttemptAt: new Date(Date.now() + delayMs),
      lastError: message
    }
  });
}

export async function alertOnStalePaymentActivations() {
  const webhookUrl = process.env.CAPTYN_WIFI_PAYMENT_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;
  let url: URL;
  try { url = new URL(webhookUrl); } catch { console.error("Payment activation alert webhook URL is invalid"); return; }
  if (url.protocol !== "https:") { console.error("Payment activation alert webhook must use HTTPS"); return; }

  const cutoff = new Date(Date.now() - 15 * 60_000);
  const stale = await prisma.wifiPaymentActivationJob.findMany({
    where: {
      AND: [
        { OR: [
          { status: "queued", createdAt: { lt: cutoff } },
          { status: "processing", lockedAt: { lt: cutoff } },
          { status: "manual_review", createdAt: { lt: cutoff } }
        ] },
        { OR: [
          { lastAlertedAt: null },
          { lastAlertedAt: { lt: new Date(Date.now() - 30 * 60_000) } }
        ] }
      ]
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true, paymentIntentId: true, attempts: true, createdAt: true }
  });
  if (!stale.length) return;
  const oldestAgeMinutes = Math.floor((Date.now() - stale[0].createdAt.getTime()) / 60_000);
  await prisma.wifiPaymentActivationJob.updateMany({
    where: { id: { in: stale.map((job) => job.id) } },
    data: { lastAlertedAt: new Date() }
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "wifi.payment_activation.backlog",
        occurredAt: new Date().toISOString(),
        queuedCount: stale.length,
        oldestAgeMinutes,
        jobs: stale.map(({ paymentIntentId, attempts }) => ({ paymentIntentId, attempts }))
      }),
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
  } catch (error) {
    console.error("Payment activation alert webhook delivery failed:", error instanceof Error ? error.message : error);
  }
}
