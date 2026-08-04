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
import { type Address, parseEventLogs } from "viem";

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
  /** Called once per settled (non-idempotent) payment — surface at /payments. */
  recordPayment: (p: PaymentRecord) => void;
  state?: X402State; // injectable for tests; defaults to module singleton
}

export interface Quote {
  resource: string;
  price: bigint;
  validUntil: number;
}

/** Quote/claim bookkeeping, store-shaped so implementations can be in-memory
 *  (tests, dev) or durable (SQLite in the seller — replay protection must
 *  survive restarts). */
export interface X402State {
  getQuote(id: string): Quote | undefined;
  setQuote(id: string, q: Quote): void;
  deleteQuote(id: string): void;
  /** txHash that already claimed this quote, if any. */
  getConsumed(id: string): `0x${string}` | undefined;
  setConsumed(id: string, txHash: `0x${string}`): void;
  hasUsedTx(txHash: string): boolean;
  addUsedTx(txHash: string): void;
  pruneQuotes(now: number): void;
}

export function createX402State(): X402State {
  const quotes = new Map<string, Quote>();
  const consumed = new Map<string, `0x${string}`>();
  const usedTxHashes = new Set<string>();
  return {
    getQuote: (id) => quotes.get(id),
    setQuote: (id, q) => void quotes.set(id, q),
    deleteQuote: (id) => void quotes.delete(id),
    getConsumed: (id) => consumed.get(id),
    setConsumed: (id, tx) => void consumed.set(id, tx),
    hasUsedTx: (tx) => usedTxHashes.has(tx),
    addUsedTx: (tx) => void usedTxHashes.add(tx),
    pruneQuotes: (now) => {
      for (const [id, q] of quotes) {
        if (now > q.validUntil) quotes.delete(id);
      }
    },
  };
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
  opts: {
    network: string;
    payTo: Address;
    usdc: Address;
    state: X402State;
    getReceipt: GetReceipt;
    verifySignature: VerifySignature;
  },
): Promise<VerifyOk | VerifyFail> {
  const { txHash, from, to, amount, quoteId, signature } = payload.payload;
  const { state } = opts;

  if (payload.network !== opts.network) return { ok: false, status: 402, error: "wrong network" };
  if (to.toLowerCase() !== opts.payTo.toLowerCase()) return { ok: false, status: 402, error: "wrong payee" };
  if (BigInt(amount) < price) return { ok: false, status: 402, error: "insufficient payment" };

  // Payer binding: only whoever controls `from` can claim this transfer.
  // Must go through the client-bound verifier (ERC-6492/1271 aware) — plain
  // viem `verifyMessage` only recovers ECDSA and rejects every smart-contract
  // wallet (e.g. Circle SCA), signature format notwithstanding.
  let sigOk = false;
  try {
    sigOk = await opts.verifySignature({ address: from, message: paymentSigMessage(quoteId, txHash), signature });
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, status: 402, error: "invalid payment signature" };

  // Idempotent re-claim: same quote, same tx, valid signature → serve again
  // without re-recording (client recovering from a lost response).
  const claimedBy = state.getConsumed(quoteId);
  if (claimedBy) {
    if (claimedBy === txHash.toLowerCase()) return { ok: true, idempotent: true };
    return { ok: false, status: 402, error: "quote already claimed" };
  }

  const quote = state.getQuote(quoteId);
  if (!quote) return { ok: false, status: 402, error: "unknown or expired quote" };
  if (Date.now() > quote.validUntil) return { ok: false, status: 402, error: "quote expired" };
  if (quote.resource !== resource) return { ok: false, status: 402, error: "quote is for another resource" };
  if (state.hasUsedTx(txHash.toLowerCase())) {
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

  state.addUsedTx(txHash.toLowerCase());
  state.setConsumed(quoteId, txHash.toLowerCase() as `0x${string}`);
  state.deleteQuote(quoteId);
  return { ok: true, idempotent: false };
}

type GetReceipt = (hash: `0x${string}`) => Promise<{
  status: string;
  logs: Parameters<typeof parseEventLogs>[0]["logs"];
}>;

type VerifySignature = (params: { address: Address; message: string; signature: `0x${string}` }) => Promise<boolean>;

/** Hono middleware implementing the x402 handshake with on-chain USDC settlement
 *  verification (agentmesh-direct scheme). `price` is USDC base units (6 dp). */
export function priced(price: bigint, description: string, opts: X402Options) {
  const state = opts.state ?? defaultState;
  return async (c: Context, next: Next) => {
    const header = c.req.header(X_PAYMENT_HEADER);
    const resource = new URL(c.req.url).pathname;

    if (!header) {
      state.pruneQuotes(Date.now());
      const quoteId = randomUUID();
      const validUntil = Date.now() + QUOTE_TTL_MS;
      state.setQuote(quoteId, { resource, price, validUntil });
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
      verifySignature: (p) => opts.mesh.publicClient.verifyMessage(p),
    });
    if (!verdict.ok) return c.json({ error: verdict.error }, verdict.status);

    const { txHash, from, amount } = payload.payload;
    if (!verdict.idempotent) {
      opts.recordPayment({ ts: Date.now(), from, amount, txHash, resource });
    }
    c.header(
      X_PAYMENT_RESPONSE_HEADER,
      Buffer.from(JSON.stringify({ settled: true, txHash, network: opts.network })).toString("base64"),
    );
    await next();
  };
}
