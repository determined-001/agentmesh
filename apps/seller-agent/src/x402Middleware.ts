import { randomUUID } from "node:crypto";
import type { AgentMeshClient } from "@agentmesh/sdk";
import {
  decodePaymentHeader,
  type NetworkName,
  type PaymentPayload,
  type PaymentRequirements,
  paymentSigMessage,
  usdcAbi,
  X_PAYMENT_HEADER,
  X_PAYMENT_RESPONSE_HEADER,
} from "@agentmesh/shared";
import type { Context, Next } from "hono";
import { type Address, parseEventLogs, verifyMessage } from "viem";

export interface PaymentRecord {
  ts: number;
  from: Address;
  amount: string; // base units
  txHash: `0x${string}`;
  resource: string;
}

export interface X402Options {
  mesh: AgentMeshClient;
  network: NetworkName;
  payTo: Address;
  payments: PaymentRecord[]; // shared log, surfaced at /payments for the dashboard
  state?: X402State; // injectable for tests; defaults to module singleton
}

/** Quote/claim bookkeeping. In-memory for now — durable store lands with the
 *  persistence phase; the verification logic is already store-shaped. */
export interface X402State {
  quotes: Map<string, { resource: string; price: bigint; validUntil: number }>;
  consumed: Map<string, `0x${string}`>; // quoteId → txHash that claimed it
  usedTxHashes: Set<string>;
}

export function createX402State(): X402State {
  return { quotes: new Map(), consumed: new Map(), usedTxHashes: new Set() };
}

const defaultState = createX402State();

export const QUOTE_TTL_MS = 5 * 60_000;

type VerifyOk = { ok: true; idempotent: boolean };
type VerifyFail = { ok: false; status: 400 | 402; error: string };

/** Full claim verification. Exported for direct unit testing. */
export async function verifyPaymentClaim(
  payload: PaymentPayload,
  resource: string,
  price: bigint,
  opts: { network: string; payTo: Address; usdc: Address; state: X402State; getReceipt: GetReceipt },
): Promise<VerifyOk | VerifyFail> {
  const { txHash, from, to, amount, quoteId, signature } = payload.payload;
  const { state } = opts;

  if (payload.network !== opts.network) return { ok: false, status: 402, error: "wrong network" };
  if (to.toLowerCase() !== opts.payTo.toLowerCase()) return { ok: false, status: 402, error: "wrong payee" };
  if (BigInt(amount) < price) return { ok: false, status: 402, error: "insufficient payment" };

  // Payer binding: only whoever controls `from` can claim this transfer.
  let sigOk = false;
  try {
    sigOk = await verifyMessage({ address: from, message: paymentSigMessage(quoteId, txHash), signature });
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, status: 402, error: "invalid payment signature" };

  // Idempotent re-claim: same quote, same tx, valid signature → serve again
  // without re-recording (client recovering from a lost response).
  const claimedBy = state.consumed.get(quoteId);
  if (claimedBy) {
    if (claimedBy === txHash.toLowerCase()) return { ok: true, idempotent: true };
    return { ok: false, status: 402, error: "quote already claimed" };
  }

  const quote = state.quotes.get(quoteId);
  if (!quote) return { ok: false, status: 402, error: "unknown or expired quote" };
  if (Date.now() > quote.validUntil) return { ok: false, status: 402, error: "quote expired" };
  if (quote.resource !== resource) return { ok: false, status: 402, error: "quote is for another resource" };
  if (state.usedTxHashes.has(txHash.toLowerCase())) {
    return { ok: false, status: 402, error: "payment already used" };
  }

  // Verify the USDC transfer actually settled on Arc.
  let receipt: Awaited<ReturnType<GetReceipt>>;
  try {
    receipt = await opts.getReceipt(txHash);
  } catch {
    return { ok: false, status: 402, error: "payment tx not found" };
  }
  if (receipt.status !== "success") return { ok: false, status: 402, error: "payment tx reverted" };
  const transfers = parseEventLogs({ abi: usdcAbi, logs: receipt.logs, eventName: "Transfer" });
  const match = transfers.find(
    (t) =>
      t.address.toLowerCase() === opts.usdc.toLowerCase() &&
      (t.args.from as string).toLowerCase() === from.toLowerCase() &&
      (t.args.to as string).toLowerCase() === opts.payTo.toLowerCase() &&
      (t.args.value as bigint) >= price,
  );
  if (!match) return { ok: false, status: 402, error: "no matching USDC transfer in tx" };

  state.usedTxHashes.add(txHash.toLowerCase());
  state.consumed.set(quoteId, txHash.toLowerCase() as `0x${string}`);
  state.quotes.delete(quoteId);
  return { ok: true, idempotent: false };
}

type GetReceipt = (hash: `0x${string}`) => Promise<{
  status: string;
  logs: Parameters<typeof parseEventLogs>[0]["logs"];
}>;

function pruneQuotes(state: X402State) {
  const now = Date.now();
  for (const [id, q] of state.quotes) {
    if (now > q.validUntil) state.quotes.delete(id);
  }
}

/** Hono middleware implementing the x402 handshake with on-chain USDC settlement
 *  verification (agentmesh-direct scheme). `price` is USDC base units (6 dp). */
export function priced(price: bigint, description: string, opts: X402Options) {
  const state = opts.state ?? defaultState;
  return async (c: Context, next: Next) => {
    const header = c.req.header(X_PAYMENT_HEADER);
    const resource = new URL(c.req.url).pathname;

    if (!header) {
      pruneQuotes(state);
      const quoteId = randomUUID();
      const validUntil = Date.now() + QUOTE_TTL_MS;
      state.quotes.set(quoteId, { resource, price, validUntil });
      const requirements: PaymentRequirements = {
        x402Version: 1,
        scheme: "agentmesh-direct",
        network: opts.network,
        payTo: opts.payTo,
        asset: opts.mesh.deployment.usdc,
        maxAmountRequired: price.toString(),
        resource,
        description,
        quoteId,
        validUntil,
      };
      return c.json(requirements, 402);
    }

    let payload: PaymentPayload;
    try {
      payload = decodePaymentHeader(header);
    } catch {
      return c.json({ error: "malformed X-PAYMENT header" }, 400);
    }

    const verdict = await verifyPaymentClaim(payload, resource, price, {
      network: opts.network,
      payTo: opts.payTo,
      usdc: opts.mesh.deployment.usdc,
      state,
      getReceipt: (hash) => opts.mesh.publicClient.getTransactionReceipt({ hash }),
    });
    if (!verdict.ok) return c.json({ error: verdict.error }, verdict.status);

    const { txHash, from, amount } = payload.payload;
    if (!verdict.idempotent) {
      opts.payments.push({ ts: Date.now(), from, amount, txHash, resource });
    }
    c.header(
      X_PAYMENT_RESPONSE_HEADER,
      Buffer.from(JSON.stringify({ settled: true, txHash, network: opts.network })).toString("base64"),
    );
    await next();
  };
}
