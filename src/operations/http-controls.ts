import type { RequestHandler } from "express";

export class OperationalMetrics {
  readonly #counts = new Map<string, number>();

  public increment(metric: string, labels: Record<string, string> = {}): void {
    const suffix = Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}="${value.replaceAll(/[^a-zA-Z0-9_.-]/gu, "_")}"`)
      .join(",");
    const key = suffix.length === 0 ? metric : `${metric}{${suffix}}`;
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  public render(): string {
    return [...this.#counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key} ${value}`)
      .join("\n");
  }
}

export function requestMetrics(metrics: OperationalMetrics): RequestHandler {
  return (request, response, next) => {
    const started = performance.now();
    response.once("finish", () => {
      metrics.increment("evllm_http_requests_total", {
        method: request.method,
        status: String(response.statusCode),
      });
      if (performance.now() - started >= 5_000) metrics.increment("evllm_http_slow_total");
    });
    next();
  };
}

export function rateLimit(options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxBuckets?: number;
  readonly cleanupEvery?: number;
  readonly now?: () => number;
}): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const now = options.now ?? Date.now;
  const maxBuckets = positiveInteger(options.maxBuckets ?? 10_000, "rate-limit bucket capacity");
  const cleanupEvery = positiveInteger(options.cleanupEvery ?? 256, "rate-limit cleanup interval");
  positiveInteger(options.limit, "rate limit");
  positiveInteger(options.windowMs, "rate-limit window");
  let requestCount = 0;
  return (request, response, next) => {
    const key = `${request.ip}:${request.path.startsWith("/api/v1/auth") ? "auth" : "api"}`;
    const time = now();
    requestCount += 1;
    if (requestCount % cleanupEvery === 0) removeExpiredBuckets(buckets, time);
    const current = buckets.get(key);
    if (current === undefined && buckets.size >= maxBuckets) {
      removeExpiredBuckets(buckets, time);
      if (buckets.size >= maxBuckets) {
        const earliestReset = Math.min(...[...buckets.values()].map(({ resetAt }) => resetAt));
        rejectRateLimited(response, options.limit, Math.max(time + 1_000, earliestReset), time);
        return;
      }
    }
    const bucket =
      current === undefined || current.resetAt <= time
        ? { count: 0, resetAt: time + options.windowMs }
        : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    response.setHeader("ratelimit-limit", String(options.limit));
    response.setHeader("ratelimit-remaining", String(Math.max(0, options.limit - bucket.count)));
    if (bucket.count > options.limit) {
      rejectRateLimited(response, options.limit, bucket.resetAt, time);
      return;
    }
    next();
  };
}

function removeExpiredBuckets(
  buckets: Map<string, { count: number; resetAt: number }>,
  currentTime: number,
): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= currentTime) buckets.delete(key);
  }
}

function rejectRateLimited(
  response: Parameters<RequestHandler>[1],
  limit: number,
  resetAt: number,
  currentTime: number,
): void {
  response.setHeader("ratelimit-limit", String(limit));
  response.setHeader("ratelimit-remaining", "0");
  response.setHeader("retry-after", String(Math.max(1, Math.ceil((resetAt - currentTime) / 1000))));
  response.status(429).json({
    error: {
      code: "RATE_LIMITED",
      correlation_id: String(response.getHeader("x-correlation-id") ?? ""),
      message: "Request rate limit exceeded.",
    },
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

export async function retryTransient<T>(
  operation: (attempt: number) => Promise<T>,
  options: { readonly attempts: number; readonly baseDelayMs: number },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts) break;
      await new Promise((resolve) => setTimeout(resolve, options.baseDelayMs * attempt));
    }
  }
  throw lastError;
}
