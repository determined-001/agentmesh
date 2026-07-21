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

export function encodePaymentHeader(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}

export function decodePaymentHeader(header: string): PaymentPayload {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
}
