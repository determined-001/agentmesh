import {
  assertAgentEndpoint,
  decodePaymentHeader,
  encodePaymentHeader,
  type PaymentPayload,
  type PaymentRequirements,
  paymentSigMessage,
  safeFetch,
  X_PAYMENT_HEADER,
  X_PAYMENT_RESPONSE_HEADER,
} from "@agentmesh/shared";
import { type Address, isAddress } from "viem";
import type { AgentMeshClient } from "./client.js";
import type { SpendBudget } from "./spendBudget.js";

/** Who this client is willing to send money to.
 *
 *  Required, with no default, because the payee arrives in the *server's* 402
 *  body: a hostile endpoint that simply names its own address was able to
 *  collect real USDC. The payee must be decided by the caller — normally from
 *  the registry resolution it already performed — not by the thing being paid.
 *
 *  - `expect`          — exactly this address (strongest; use when the caller
 *                        resolved the agent itself)
 *  - `allowlist`       — one of these addresses
 *  - `registeredAgent` — any wallet currently in the AgentMesh registry
 */
export type PayeePolicy = { expect: Address } | { allowlist: readonly Address[] } | { registeredAgent: true };

async function assertPayeeAllowed(mesh: AgentMeshClient, payTo: Address, policy: PayeePolicy): Promise<void> {
  const target = payTo.toLowerCase();
  if ("expect" in policy) {
    if (target !== policy.expect.toLowerCase()) {
      throw new Error(`server asked to be paid at ${payTo}, expected ${policy.expect}`);
    }
    return;
  }
  if ("allowlist" in policy) {
    if (!policy.allowlist.some((a) => a.toLowerCase() === target)) {
      throw new Error(`server asked to be paid at ${payTo}, which is not on the payee allowlist`);
    }
    return;
  }
  if (!(await mesh.isRegisteredWallet(payTo))) {
    throw new Error(`server asked to be paid at ${payTo}, which is not a registered AgentMesh agent`);
  }
}

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
  opts: {
    /** Hard cap for this call. Required — an unbounded paid fetch is a bug. */
    maxAmount: bigint;
    /** Who may be paid. Required; see {@link PayeePolicy}. */
    payeePolicy: PayeePolicy;
    /** Process-wide ceiling that the caller's `maxAmount` cannot exceed. */
    budget?: SpendBudget;
    init?: RequestInit;
    presentPayment?: string;
  },
): Promise<PaidFetchResult> {
  // Registry endpoints are attacker-registrable and so is any URL handed to an
  // agent, so the target is checked before we talk to it at all.
  const allowPrivate = mesh.deployment.network === "local";
  assertAgentEndpoint(url, { allowPrivate });

  if (opts.presentPayment) {
    const payload = decodePaymentHeader(opts.presentPayment);
    const response = await safeFetch(url, {
      allowPrivate,
      init: {
        ...opts.init,
        headers: { ...(opts.init?.headers ?? {}), [X_PAYMENT_HEADER]: opts.presentPayment },
      },
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

  const first = await safeFetch(url, { allowPrivate, init: opts.init });
  if (first.status !== 402) return { response: first };

  const req = (await first.json()) as PaymentRequirements;

  // Everything below comes from the server being paid, so none of it is
  // trusted until checked.
  if (!isAddress(req.payTo)) throw new Error(`Seller returned a malformed payTo: ${String(req.payTo)}`);
  if (!isAddress(req.asset)) throw new Error(`Seller returned a malformed asset: ${String(req.asset)}`);
  if (req.network !== mesh.deployment.network) {
    throw new Error(
      `Seller quoted network ${req.network}; this client settles on ${mesh.deployment.network}`,
    );
  }
  if (req.asset.toLowerCase() !== mesh.deployment.usdc.toLowerCase()) {
    throw new Error(`Seller requested unknown asset ${req.asset}; expected USDC ${mesh.deployment.usdc}`);
  }
  await assertPayeeAllowed(mesh, req.payTo, opts.payeePolicy);

  const amount = BigInt(req.maxAmountRequired);
  if (amount <= 0n) throw new Error(`Seller quoted a non-positive amount: ${req.maxAmountRequired}`);
  if (amount > opts.maxAmount) {
    throw new Error(
      `Payment required (${amount} base units) exceeds maxAmount (${opts.maxAmount}) for ${url}`,
    );
  }
  opts.budget?.assertAffordable(amount);

  const from = await mesh.wallet.getAddress();
  const txHash = await mesh.transferUsdc(req.payTo, amount);
  opts.budget?.record(amount);
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
    retry = await safeFetch(url, {
      allowPrivate,
      init: {
        ...opts.init,
        headers: { ...(opts.init?.headers ?? {}), [X_PAYMENT_HEADER]: paymentHeader },
      },
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
