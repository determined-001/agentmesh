import { type PaymentPayload, paymentSigMessage, usdcAbi } from "@agentmesh/shared";
import { type Address, encodeEventTopics, type Hex, numberToHex, padHex, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { createX402State, verifyPaymentClaim, type X402State } from "./x402Middleware.js";

// anvil dev keys — test-only, never funded anywhere real
const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const PAY_TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const TX = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const PRICE = 1_000n;

function receiptWithTransfer(from: Address, to: Address, value: bigint, token: Address = USDC) {
  return {
    status: "success",
    logs: [
      {
        address: token,
        topics: encodeEventTopics({ abi: usdcAbi, eventName: "Transfer", args: { from, to } }),
        data: padHex(numberToHex(value), { size: 32 }),
      },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake receipt for parseEventLogs
  } as any;
}

async function makePayload(
  opts: { quoteId: string; txHash?: Hex; signer?: typeof payer; from?: Address; amount?: bigint } = {
    quoteId: "q1",
  },
): Promise<PaymentPayload> {
  const txHash = opts.txHash ?? TX;
  const signer = opts.signer ?? payer;
  return {
    x402Version: 1,
    scheme: "agentmesh-direct",
    network: "local",
    payload: {
      txHash,
      from: opts.from ?? payer.address,
      to: PAY_TO,
      amount: (opts.amount ?? PRICE).toString(),
      quoteId: opts.quoteId,
      signature: await signer.signMessage({ message: paymentSigMessage(opts.quoteId, txHash) }),
    },
  };
}

describe("verifyPaymentClaim", () => {
  let state: X402State;
  const base = {
    network: "local",
    payTo: PAY_TO,
    usdc: USDC,
    getReceipt: async () => receiptWithTransfer(payer.address, PAY_TO, PRICE),
    verifySignature: verifyMessage,
  };

  beforeEach(() => {
    state = createX402State();
    state.setQuote("q1", { resource: "/api/headline", price: PRICE, validUntil: Date.now() + 60_000 });
  });

  it("accepts a valid signed claim and records it", async () => {
    const res = await verifyPaymentClaim(await makePayload(), "/api/headline", PRICE, { ...base, state });
    expect(res).toEqual({ ok: true, idempotent: false });
    expect(state.getConsumed("q1")).toBe(TX.toLowerCase());
    expect(state.hasUsedTx(TX.toLowerCase())).toBe(true);
    expect(state.getQuote("q1")).toBeUndefined();
  });

  it("rejects a claim signed by someone other than the payer", async () => {
    // stranger observed payer's on-chain transfer and tries to claim it
    const res = await verifyPaymentClaim(
      await makePayload({ quoteId: "q1", signer: stranger }),
      "/api/headline",
      PRICE,
      { ...base, state },
    );
    expect(res).toMatchObject({ ok: false, error: "invalid payment signature" });
  });

  it("rejects a tampered signature", async () => {
    const payload = await makePayload();
    payload.payload.signature = `${payload.payload.signature.slice(0, -2)}00` as Hex;
    const res = await verifyPaymentClaim(payload, "/api/headline", PRICE, { ...base, state });
    expect(res).toMatchObject({ ok: false, error: "invalid payment signature" });
  });

  it("replayed txHash against a fresh quote is rejected", async () => {
    await verifyPaymentClaim(await makePayload(), "/api/headline", PRICE, { ...base, state });
    state.setQuote("q2", { resource: "/api/headline", price: PRICE, validUntil: Date.now() + 60_000 });
    const res = await verifyPaymentClaim(await makePayload({ quoteId: "q2" }), "/api/headline", PRICE, {
      ...base,
      state,
    });
    expect(res).toMatchObject({ ok: false, error: "payment already used" });
  });

  it("same quote + same tx re-presented is idempotent", async () => {
    const payload = await makePayload();
    await verifyPaymentClaim(payload, "/api/headline", PRICE, { ...base, state });
    const res = await verifyPaymentClaim(payload, "/api/headline", PRICE, { ...base, state });
    expect(res).toEqual({ ok: true, idempotent: true });
  });

  it("consumed quote with a different tx is rejected", async () => {
    await verifyPaymentClaim(await makePayload(), "/api/headline", PRICE, { ...base, state });
    const otherTx = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
    const res = await verifyPaymentClaim(
      await makePayload({ quoteId: "q1", txHash: otherTx }),
      "/api/headline",
      PRICE,
      { ...base, state },
    );
    expect(res).toMatchObject({ ok: false, error: "quote already claimed" });
  });

  it("rejects unknown and expired quotes", async () => {
    const unknown = await verifyPaymentClaim(await makePayload({ quoteId: "nope" }), "/api/headline", PRICE, {
      ...base,
      state,
    });
    expect(unknown).toMatchObject({ ok: false, error: "unknown or expired quote" });

    state.setQuote("old", { resource: "/api/headline", price: PRICE, validUntil: Date.now() - 1 });
    const expired = await verifyPaymentClaim(await makePayload({ quoteId: "old" }), "/api/headline", PRICE, {
      ...base,
      state,
    });
    expect(expired).toMatchObject({ ok: false, error: "quote expired" });
  });

  it("rejects a quote issued for another resource", async () => {
    const res = await verifyPaymentClaim(await makePayload(), "/api/datapoint", PRICE, { ...base, state });
    expect(res).toMatchObject({ ok: false, error: "quote is for another resource" });
  });

  it("rejects when the receipt has no matching transfer", async () => {
    const res = await verifyPaymentClaim(await makePayload(), "/api/headline", PRICE, {
      ...base,
      state,
      getReceipt: async () => receiptWithTransfer(stranger.address, PAY_TO, PRICE),
    });
    expect(res).toMatchObject({ ok: false, error: "no matching USDC transfer in tx" });
  });

  it("rejects underpayment and reverted txs", async () => {
    const under = await verifyPaymentClaim(
      await makePayload({ quoteId: "q1", amount: 1n }),
      "/api/headline",
      PRICE,
      {
        ...base,
        state,
      },
    );
    expect(under).toMatchObject({ ok: false, error: "insufficient payment" });

    const reverted = await verifyPaymentClaim(await makePayload(), "/api/headline", PRICE, {
      ...base,
      state,
      getReceipt: async () => ({ ...receiptWithTransfer(payer.address, PAY_TO, PRICE), status: "reverted" }),
    });
    expect(reverted).toMatchObject({ ok: false, error: "payment tx reverted" });
  });
});
