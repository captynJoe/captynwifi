import type { Request, RequestHandler } from "express";

type RateLimitOptions = {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
  message?: string;
};

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10000;

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

function forwardedAddress(req: Request): string {
  const direct =
    firstHeaderValue(req.headers["cf-connecting-ip"]) ||
    firstHeaderValue(req.headers["x-real-ip"]) ||
    firstHeaderValue(req.headers["x-forwarded-for"]).split(",")[0]?.trim() ||
    req.ip ||
    req.socket.remoteAddress ||
    "unknown";
  return direct.replace(/^::ffff:/, "");
}

function cleanupBuckets(now: number) {
  let checked = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
    checked += 1;
    if (checked >= 1000) break;
  }

  if (buckets.size <= MAX_BUCKETS) return;
  let removed = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    removed += 1;
    if (removed >= 1000) break;
  }
}

export function ipKey(req: Request): string {
  return forwardedAddress(req);
}

export function bodyFieldKey(field: string, fallback = "missing") {
  return (req: Request): string => {
    const body = req.body as Record<string, unknown> | undefined;
    const value = body?.[field];
    const normalized = typeof value === "string" || typeof value === "number" ? String(value).trim().toLowerCase() : "";
    return normalized || fallback;
  };
}

export function clientRateLimit(options: RateLimitOptions): RequestHandler {
  if (options.max < 1 || options.windowMs < 1000) {
    throw new Error("Rate limit must use a positive max and a window of at least one second.");
  }

  return (req, res, next) => {
    const now = Date.now();
    cleanupBuckets(now);

    const identity = options.key?.(req) || ipKey(req);
    const bucketKey = `${options.name}:${identity}`;
    const bucket = buckets.get(bucketKey);
    const activeBucket = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + options.windowMs };
    activeBucket.count += 1;
    buckets.set(bucketKey, activeBucket);

    if (activeBucket.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((activeBucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: options.message ?? "Too many requests. Try again shortly." });
    }

    return next();
  };
}
