import { prisma } from "../prisma.js";
import { activateConfirmedPaymentIntentById } from "../routes/public.js";
import {
  alertOnStalePaymentActivations,
  claimPaymentActivationJobs,
  completePaymentActivationJob,
  markPaymentActivationForManualReview,
  retryPaymentActivationJob
} from "../services/paymentActivationQueue.js";

let running = false;

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const jobs = await claimPaymentActivationJobs();
    for (const job of jobs) {
      try {
        await activateConfirmedPaymentIntentById(job.paymentIntentId);
        await completePaymentActivationJob(job.id);
        console.log("Payment activation completed", { paymentIntentId: job.paymentIntentId, attempt: job.attempts });
      } catch (error) {
        const statusCode = typeof error === "object" && error !== null && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 0;
        if (statusCode >= 400 && statusCode < 500) {
          await markPaymentActivationForManualReview(job.id, error);
          console.error("Confirmed payment needs manual activation review", {
            paymentIntentId: job.paymentIntentId,
            statusCode,
            error: error instanceof Error ? error.message : error
          });
        } else {
          await retryPaymentActivationJob(job.id, job.attempts, error);
          console.error("Payment activation retry scheduled", {
            paymentIntentId: job.paymentIntentId,
            attempt: job.attempts,
            error: error instanceof Error ? error.message : error
          });
        }
      }
    }
    await alertOnStalePaymentActivations();
  } catch (error) {
    console.error("Payment activation worker pass failed:", error);
  } finally {
    running = false;
  }
}

console.log("Wi-Fi payment activation worker started");
void runOnce();
setInterval(() => { void runOnce(); }, 5_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void prisma.$disconnect().finally(() => process.exit(0)); });
}
