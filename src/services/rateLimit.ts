export type ParsedRateLimit = {
  uploadBps: number;
  downloadBps: number;
};

const UNIT_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  g: 1_000_000_000
};

function parseRatePart(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([kmg])?$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] || "").toLowerCase();
  const multiplier = UNIT_MULTIPLIERS[unit] || 1;
  return Number.isFinite(value) && value > 0 ? Math.round(value * multiplier) : null;
}

// The base "upload/download" pair; a burst string carries more after it.
export function baseRateLimit(rateLimit?: string | null): string {
  return String(rateLimit || "").trim().split(/\s+/)[0] || "";
}

export function parseMikrotikRateLimit(rateLimit?: string | null): ParsedRateLimit | null {
  const trimmed = baseRateLimit(rateLimit);
  const [uploadRaw, downloadRaw] = trimmed.split("/");
  if (!uploadRaw || !downloadRaw) return null;

  const uploadBps = parseRatePart(uploadRaw);
  const downloadBps = parseRatePart(downloadRaw);
  if (!uploadBps || !downloadBps) return null;

  return { uploadBps, downloadBps };
}

function formatRatePart(bps: number): string {
  const roundedMbps = Math.max(1, Math.round(bps / 1_000_000));
  return `${roundedMbps}M`;
}

export function formatMikrotikRateLimit(rate: ParsedRateLimit): string {
  return `${formatRatePart(rate.uploadBps)}/${formatRatePart(rate.downloadBps)}`;
}

export function scaleMikrotikRateLimit(rateLimit: string | null | undefined, factor: number): string | null {
  const parsed = parseMikrotikRateLimit(rateLimit);
  if (!parsed) return rateLimit || null;

  const normalizedFactor = Math.max(0.1, Math.min(1, factor));
  return formatMikrotikRateLimit({
    uploadBps: parsed.uploadBps * normalizedFactor,
    downloadBps: parsed.downloadBps * normalizedFactor
  });
}

// Compares the base speeds only, so a session whose rate carries burst
// settings isn't seen as different from its plain target -- the governor
// disconnects a device whenever these differ.
export function rateLimitEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  const parsedA = parseMikrotikRateLimit(a);
  const parsedB = parseMikrotikRateLimit(b);
  if (parsedA && parsedB) return parsedA.uploadBps === parsedB.uploadBps && parsedA.downloadBps === parsedB.downloadBps;
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

// Burst: short spurts at 2x the package speed while a device's average
// over the last 20s stays under 3/4 of it -- pages and apps open fast,
// sustained downloads settle at the package speed. Full-speed burst lasts
// about 20s x 3/4 / 2 = 7.5s. MikroTik order: rate burst-rate threshold time.
export const BURST_MULTIPLIER = 2;
export const BURST_THRESHOLD_SHARE = 0.75;
export const BURST_TIME_SECONDS = 20;

function formatBps(bps: number): string {
  const rounded = Math.max(1000, Math.round(bps / 1000) * 1000);
  return rounded % 1_000_000 === 0 ? `${rounded / 1_000_000}M` : `${rounded / 1000}k`;
}

export function withBurst(rateLimit: string | null | undefined): string | null {
  const parsed = parseMikrotikRateLimit(rateLimit);
  if (!parsed) return rateLimit ?? null;
  const pair = (factor: number) => `${formatBps(parsed.uploadBps * factor)}/${formatBps(parsed.downloadBps * factor)}`;
  return `${baseRateLimit(rateLimit)} ${pair(BURST_MULTIPLIER)} ${pair(BURST_THRESHOLD_SHARE)} ${BURST_TIME_SECONDS}/${BURST_TIME_SECONDS}`;
}
