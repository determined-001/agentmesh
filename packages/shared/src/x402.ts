import type { Address, Hex } from "viem";
import { z } from "zod";

/** Wire types for AgentMesh's x402-compatible payment handshake.
 *
 *  Flow (per the x402 pattern: HTTP 402 → pay → retry with X-PAYMENT header):
 *    1. Client requests a priced endpoint, gets 402 + PaymentRequirements JSON.
 *    2. Client settles: on-chain USDC transfer on Arc (`agentmesh-direct` scheme).
 *       (Upgrade path: Circle Gateway Nanopayments batching — same wire shape.)
 *    3. Client retries with `X-PAYMENT: base64(PaymentPayload)`.
 *    4. Server verifies the transfer on-chain and serves the response, echoing
 *       `X-PAYMENT-RESPONSE` with settlement details.
 */
export const X_PAYMENT_HEADER = "x-payment";
export const X_PAYMENT_RESPONSE_HEADER = "x-payment-response";

export interface PaymentRequirements {
  x402Version: number;
  scheme: "agentmesh-direct";
  network: string; // e.g. "arc-testnet" | "local"
  payTo: Address;
  asset: Address; // USDC ERC-20 address
  maxAmountRequired: string; // USDC base units (6 decimals), stringified
  resource: string;
  description: string;
  /** Server-issued one-time quote id the payment must be bound to. */
  quoteId: string;
  /** Unix ms after which the quote (and any payment against it) is rejected. */
  validUntil: number;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: "agentmesh-direct";
  network: string;
  payload: {
    txHash: Hex;
    from: Address;
    to: Address;
    amount: string; // USDC base units
    /** Echo of the server's quoteId — one payment claims exactly one quote. */
    quoteId: string;
    /** Payer's signature over paymentSigMessage(quoteId, txHash). Binds the
     *  claim to whoever controls `from`: a third party that merely observed
     *  the transfer on-chain cannot present it as their own payment. */
    signature: Hex;
  };
}

/** Canonical message the payer signs to claim a payment. */
export function paymentSigMessage(quoteId: string, txHash: Hex): string {
  return `agentmesh-x402|${quoteId}|${txHash}`;
}

/* Base64 helpers using only web-standard APIs (TextEncoder/atob/btoa) so this
 * module works in Node, browsers, and extension contexts alike — no Buffer. */
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

export function encodePaymentHeader(p: PaymentPayload): string {
  return utf8ToBase64(JSON.stringify(p));
}

const hex = (label: string) =>
  z.string().regex(/^0x[0-9a-fA-F]*$/, `${label} must be a 0x-prefixed hex string`);

/** Shape of an X-PAYMENT header. Every field arrives from an unauthenticated
 *  caller, so the header is parsed rather than cast: without this, a payload
 *  like `{}` or `{"payload":{"amount":"abc"}}` reached code that called
 *  `.toLowerCase()` and `BigInt()` on it and threw an unhandled TypeError,
 *  turning any malformed header into a 500 and a stack trace in the logs. */
export const paymentPayloadSchema = z.object({
  x402Version: z.number().int().nonnegative().optional(),
  scheme: z.literal("agentmesh-direct"),
  network: z.string().min(1),
  payload: z.object({
    txHash: hex("txHash").length(66),
    from: hex("from").length(42),
    to: hex("to").length(42),
    amount: z.string().regex(/^\d+$/, "amount must be a decimal base-unit string"),
    quoteId: z.string().min(1).max(200),
    signature: hex("signature"),
  }),
});

/** @throws if the header is not valid base64, not JSON, or not a well-formed
 *  payload. Callers turn the throw into a 400. */
export function decodePaymentHeader(header: string): PaymentPayload {
  const parsed = paymentPayloadSchema.parse(JSON.parse(base64ToUtf8(header)));
  return { x402Version: parsed.x402Version ?? 1, ...parsed } as PaymentPayload;
}
