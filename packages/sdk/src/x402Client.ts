import type { Address } from "viem";
import {
  decodePaymentHeader,
  encodePaymentHeader,
  X_PAYMENT_HEADER,
  X_PAYMENT_RESPONSE_HEADER,
  type PaymentPayload,
  type PaymentRequirements,
} from "@agentmesh/shared";
import type { AgentMeshClient } from "./client.js";

export interface PaidFetchResult {
  response: Response;
  paid?: {
    amount: bigint;
    txHash: `0x${string}`;
    payTo: Address;
    settlement?: string; // X-PAYMENT-RESPONSE echo from the server
  };
}

/** x402-style paid fetch: request → HTTP 402 with PaymentRequirements →
 *  settle USDC on Arc → retry with X-PAYMENT header.
 *  `maxAmount` caps what the client is willing to pay per call. */
export async function paidFetch(
  mesh: AgentMeshClient,
  url: string,
  opts: { maxAmount?: bigint; init?: RequestInit } = {}
): Promise<PaidFetchResult> {
  const first = await fetch(url, opts.init);
  if (first.status !== 402) return { response: first };

  const req = (await first.json()) as PaymentRequirements;
  const amount = BigInt(req.maxAmountRequired);
  if (opts.maxAmount !== undefined && amount > opts.maxAmount) {
    throw new Error(
      `Payment required (${amount} base units) exceeds maxAmount (${opts.maxAmount}) for ${url}`
    );
  }
  if (req.asset.toLowerCase() !== mesh.deployment.usdc.toLowerCase()) {
    throw new Error(`Seller requested unknown asset ${req.asset}; expected USDC ${mesh.deployment.usdc}`);
  }

  const from = await mesh.wallet.getAddress();
  const txHash = await mesh.transferUsdc(req.payTo, amount);

  const payload: PaymentPayload = {
    x402Version: req.x402Version,
    scheme: "agentmesh-direct",
    network: req.network,
    payload: { txHash, from, to: req.payTo, amount: amount.toString() },
  };

  const retry = await fetch(url, {
    ...opts.init,
    headers: { ...(opts.init?.headers ?? {}), [X_PAYMENT_HEADER]: encodePaymentHeader(payload) },
  });

  return {
    response: retry,
    paid: {
      amount,
      txHash,
      payTo: req.payTo,
      settlement: retry.headers.get(X_PAYMENT_RESPONSE_HEADER) ?? undefined,
    },
  };
}

export { decodePaymentHeader };
