import { assertAgentEndpoint } from "./url.js";

/** Fetch wrapper for attacker-supplied URLs (registry endpoints, x402 resources).
 *
 *  `checkAgentEndpoint` only ever sees the URL you hand it, so a plain `fetch`
 *  undoes it: fetch follows redirects by default, and a public host is free to
 *  answer 302 with `Location: http://169.254.169.254/…`. This resolves each hop
 *  itself and re-runs the guard before every request.
 *
 *  Also bounds what a hostile endpoint can cost us: a request timeout, a hop
 *  limit, and a response-size cap (an agent endpoint that streams forever must
 *  not be able to exhaust our memory). */
export interface SafeFetchOptions {
  /** Permit loopback/private targets — only for the local demo network. */
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  init?: RequestInit;
}

export const SAFE_FETCH_DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 1_000_000,
  maxRedirects: 3,
} as const;

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? SAFE_FETCH_DEFAULTS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_DEFAULTS.maxRedirects;

  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    assertAgentEndpoint(url, { allowPrivate: opts.allowPrivate });
    const res = await fetch(url, {
      ...opts.init,
      redirect: "manual", // never let the runtime follow a hop we haven't checked
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!REDIRECT_CODES.has(res.status)) return capBody(res, maxBytes);

    const location = res.headers.get("location");
    if (!location) return capBody(res, maxBytes);
    if (hop >= maxRedirects) {
      throw new Error(`too many redirects from ${rawUrl} (limit ${maxRedirects})`);
    }
    url = new URL(location, url).toString(); // resolve relative Location headers
  }
}

/** Drain at most `maxBytes` and hand back an equivalent Response. */
async function capBody(res: Response, maxBytes: number): Promise<Response> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response too large: ${declared} bytes (limit ${maxBytes})`);
  }
  if (!res.body) return res;

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error(`response too large (limit ${maxBytes} bytes)`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
