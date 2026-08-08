import type { Context, Next } from "hono";

/** Per-IP token bucket.
 *
 *  Every unpaid request to a priced route mints a quote row that lives for the
 *  quote TTL, so unauthenticated traffic translates directly into database
 *  writes: 300 requests produced 302 rows and 4 MB of WAL in six seconds, with
 *  nothing to stop it. Written in-house rather than adding a dependency, since
 *  the point is to reduce exposure, not widen it.
 *
 *  In-process only: it protects one instance from casual flooding, not a fleet
 *  from a distributed flood. Put a real edge limiter in front for that. */
export interface RateLimitOptions {
  /** Sustained requests per second per client. */
  rps?: number;
  /** Burst allowance above the sustained rate. */
  burst?: number;
  /** Max distinct clients tracked; beyond this the oldest are evicted so the
   *  limiter itself can't become the memory leak. */
  maxClients?: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export function createRateLimiter(opts: RateLimitOptions = {}) {
  const rps = opts.rps ?? Number(process.env.RATE_LIMIT_RPS ?? 10);
  const burst = opts.burst ?? Number(process.env.RATE_LIMIT_BURST ?? 30);
  const maxClients = opts.maxClients ?? 10_000;
  const buckets = new Map<string, Bucket>();

  function take(key: string, now: number): boolean {
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxClients) {
        // Map preserves insertion order; drop the oldest entry.
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
      b = { tokens: burst, last: now };
      buckets.set(key, b);
    }
    const refill = ((now - b.last) / 1000) * rps;
    b.tokens = Math.min(burst, b.tokens + refill);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  return async (c: Context, next: Next) => {
    // Trust the proxy header only when explicitly told to: otherwise any client
    // can spoof X-Forwarded-For and get a fresh bucket per request.
    const key =
      process.env.TRUST_PROXY === "1"
        ? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? clientAddr(c))
        : clientAddr(c);
    if (!take(key, Date.now())) {
      return c.json({ error: "rate limit exceeded" }, 429, { "retry-after": "1" });
    }
    await next();
  };
}

function clientAddr(c: Context): string {
  const info = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return info?.socket?.remoteAddress ?? "unknown";
}
