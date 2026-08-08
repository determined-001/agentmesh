import type { Address, Hex } from "viem";
import { z } from "zod";

/** Proof-of-buyer for fetching an escrow job's deliverable.
 *
 *  The report a buyer paid for used to be served to anyone who knew the job id,
 *  so one purchase leaked every future deliverable. Rather than a shared secret
 *  that has to be distributed out of band, the buyer proves control of the
 *  address recorded on-chain as `job.buyer` by signing a challenge — the same
 *  mechanism the x402 claim already uses, and one that works with smart-contract
 *  wallets (Circle SCA) via ERC-1271 when verified through a public client. */
export const DELIVERABLE_AUTH_HEADER = "x-agentmesh-auth";

/** How far ahead a caller may date an authorisation. Bounds how long a
 *  captured header stays useful. */
export const DELIVERABLE_AUTH_MAX_TTL_MS = 5 * 60_000;

export interface DeliverableAuth {
  address: Address;
  nonce: string;
  expiry: number; // unix ms
  signature: Hex;
}

/** Canonical message the buyer signs. Binds the grant to one job and one
 *  nonce, so a header captured for job 7 cannot be replayed against job 8. */
export function deliverableAuthMessage(jobId: string, nonce: string, expiry: number): string {
  return `agentmesh-deliverable|${jobId}|${nonce}|${expiry}`;
}

export const deliverableAuthSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address must be a 20-byte hex address"),
  nonce: z.string().min(8).max(200),
  expiry: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]*$/, "signature must be hex"),
});

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeDeliverableAuth(a: DeliverableAuth): string {
  return utf8ToBase64(JSON.stringify(a));
}

/** @throws if the header is not valid base64, not JSON, or malformed. */
export function decodeDeliverableAuth(header: string): DeliverableAuth {
  return deliverableAuthSchema.parse(JSON.parse(base64ToUtf8(header))) as DeliverableAuth;
}
