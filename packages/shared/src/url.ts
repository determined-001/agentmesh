/** Guard for fetching agent-supplied endpoints (registry cards are written by
 *  anyone on-chain, so every endpoint is attacker-controlled input).
 *
 *  Blocks non-HTTP schemes and obvious internal targets: loopback, RFC1918 /
 *  link-local literals, .local/.internal names. Hostname-based only — full DNS
 *  rebinding protection would need resolved-IP pinning at connect time. */

const PRIVATE_V4 =
  /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** Link-local — the cloud instance-metadata range (169.254.169.254 and friends).
 *  Blocked in every profile, `allowPrivate` included: the local demo has a
 *  legitimate need for loopback, never for the metadata service, and the local
 *  profile does sometimes get run on a cloud VM. */
const LINK_LOCAL = /^(?:169\.254\.|fe80:)/i;

const BLOCKED_NAMES = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/i;

export interface EndpointCheck {
  ok: boolean;
  reason?: string;
}

export function checkAgentEndpoint(raw: string, opts: { allowPrivate?: boolean } = {}): EndpointCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol} not allowed` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials in URL not allowed" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (LINK_LOCAL.test(host)) return { ok: false, reason: "link-local address blocked" };
  if (opts.allowPrivate) return { ok: true };

  if (BLOCKED_NAMES.test(host)) return { ok: false, reason: "internal hostname blocked" };
  if (PRIVATE_V4.test(host)) return { ok: false, reason: "private IPv4 address blocked" };
  if (host.includes(":")) {
    // IPv6 literal: block loopback, link-local, unique-local, v4-mapped
    const h = host.toLowerCase();
    if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
      return { ok: false, reason: "private IPv6 address blocked" };
    }
    // v4-mapped (::ffff:x) is normalized to hex by URL parsing; blanket-block it —
    // legitimate public endpoints don't advertise themselves that way.
    if (h.startsWith("::ffff:")) return { ok: false, reason: "v4-mapped address blocked" };
  }
  return { ok: true };
}

/** Throwing variant for call sites that just want to fetch or die. */
export function assertAgentEndpoint(raw: string, opts: { allowPrivate?: boolean } = {}): void {
  const res = checkAgentEndpoint(raw, opts);
  if (!res.ok) throw new Error(`unsafe agent endpoint ${raw}: ${res.reason}`);
}
