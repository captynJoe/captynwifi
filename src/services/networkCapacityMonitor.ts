import { prisma } from "../prisma.js";
import { getRouterCapacityStatus } from "./routeros.js";

const RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let captureInProgress = false;
let lastCleanupAt = 0;

/** Persist one read-only RouterOS capacity sample for the admin history view. */
export async function captureNetworkCapacitySample() {
  if (captureInProgress) return null;
  captureInProgress = true;
  try {
    const snapshot = await getRouterCapacityStatus();
    if (!snapshot.configured) return null;

    const linkMbps = snapshot.wan.rateMbps;
    const guaranteedUploadMbps = snapshot.queueSummary.guaranteedUploadMbps;
    const guaranteedDownloadMbps = snapshot.queueSummary.guaranteedDownloadMbps;
    const overcommitted = linkMbps !== null && linkMbps > 0 && (
      guaranteedUploadMbps > linkMbps || guaranteedDownloadMbps > linkMbps
    );

    const saved = await prisma.wifiNetworkCapacitySample.create({
      data: {
        connected: snapshot.connected,
        wanLinkMbps: linkMbps,
        wanDownloadMbps: snapshot.wan.rxMbps,
        wanUploadMbps: snapshot.wan.txMbps,
        activeQueueCount: snapshot.queueSummary.activeCount,
        guaranteedUploadMbps,
        guaranteedDownloadMbps,
        overcommitted,
        ethernetLinks: snapshot.ethernet
      }
    });

    const now = Date.now();
    if (now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      lastCleanupAt = now;
      await prisma.wifiNetworkCapacitySample.deleteMany({
        where: { createdAt: { lt: new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000) } }
      });
    }
    return saved;
  } finally {
    captureInProgress = false;
  }
}
