import {
  decodePaymentHeader,
  encodePaymentHeader,
  type PaymentPayload,
  type PaymentRequirements,
  paymentSigMessage,
  X_PAYMENT_HEADER,
  X_PAYMENT_RESPONSE_HEADER,
} from "@agentmesh/shared";
import type { Address } from "viem";
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

/** Thrown when USDC was spent but the paid retry never reached the server.
 *  Carries everything needed to re-present the claim without paying twice:
 *  `paidFetch(mesh, url, { presentPayment: err.paymentHeader })`. */
export class PaymentOrphanedError extends Error {
  readonly txHash: `0x${string}`;
  readonly quoteId: string;
  readonly paymentHeader: string;

  constructor(url: string, txHash: `0x${string}`, quoteId: string, paymentHeader: string, cause: unknown) {
    super(`payment ${txHash} settled but retry to ${url} failed — re-present with presentPayment`, { cause });
    this.name = "PaymentOrphanedError";
    this.txHash = txHash;
    this.quoteId = quoteId;
    this.paymentHeader = paymentHeader;
  }
}

/** x402-style paid fetch: request → HTTP 402 with PaymentRequirements →
 *  settle USDC on Arc → sign the claim → retry with X-PAYMENT header.
 *  `maxAmount` caps what the client is willing to pay per call.
 *  `presentPayment` re-presents a previously-settled claim (idempotent on the
 *  server) instead of paying again. */
export async function paidFetch(
  mesh: AgentMeshClient,
  url: string,
  opts: { maxAmount?: bigint; init?: RequestInit; presentPayment?: string } = {},
): Promise<PaidFetchResult> {
  if (opts.presentPayment) {
    const payload = decodePaymentHeader(opts.presentPayment);
    const response = await fetch(url, {
      ...opts.init,
      headers: { ...(opts.init?.headers ?? {}), [X_PAYMENT_HEADER]: opts.presentPayment },
    });
    return {
      response,
      paid: {
        amount: BigInt(payload.payload.amount),
        txHash: payload.payload.txHash,
        payTo: payload.payload.to,
        settlement: response.headers.get(X_PAYMENT_RESPONSE_HEADER) ?? undefined,
      },
    };
  }

  const first = await fetch(url, opts.init);
  if (first.status !== 402) return { response: first };

  const req = (await first.json()) as PaymentRequirements;
  const amount = BigInt(req.maxAmountRequired);
  if (opts.maxAmount !== undefined && amount > opts.maxAmount) {
    throw new Error(
      `Payment required (${amount} base units) exceeds maxAmount (${opts.maxAmount}) for ${url}`,
    );
  }
  if (req.asset.toLowerCase() !== mesh.deployment.usdc.toLowerCase()) {
    throw new Error(`Seller requested unknown asset ${req.asset}; expected USDC ${mesh.deployment.usdc}`);
  }

  const from = await mesh.wallet.getAddress();
  const txHash = await mesh.transferUsdc(req.payTo, amount);
  const signature = await mesh.wallet.signMessage(paymentSigMessage(req.quoteId, txHash));

  const payload: PaymentPayload = {
    x402Version: req.x402Version,
    scheme: "agentmesh-direct",
    network: req.network,
    payload: { txHash, from, to: req.payTo, amount: amount.toString(), quoteId: req.quoteId, signature },
  };
  const paymentHeader = encodePaymentHeader(payload);

  let retry: Response;
  try {
    retry = await fetch(url, {
      ...opts.init,
      headers: { ...(opts.init?.headers ?? {}), [X_PAYMENT_HEADER]: paymentHeader },
    });
  } catch (err) {
    // Money moved but the claim never arrived — surface a recoverable error.
    throw new PaymentOrphanedError(url, txHash, req.quoteId, paymentHeader, err);
  }

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
