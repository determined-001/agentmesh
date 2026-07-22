import type { Address, Hex } from "viem";

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
  };
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

export function decodePaymentHeader(header: string): PaymentPayload {
  return JSON.parse(base64ToUtf8(header)) as PaymentPayload;
}
