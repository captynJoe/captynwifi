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

export function parseMikrotikRateLimit(rateLimit?: string | null): ParsedRateLimit | null {
  const trimmed = String(rateLimit || "").trim();
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

export function rateLimitEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}
