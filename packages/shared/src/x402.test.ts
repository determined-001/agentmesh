import { describe, expect, it } from "vitest";
import { decodePaymentHeader, encodePaymentHeader, type PaymentPayload, paymentSigMessage } from "./x402.js";

const payload: PaymentPayload = {
  x402Version: 1,
  scheme: "agentmesh-direct",
  network: "local",
  payload: {
    txHash: "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd",
    from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    amount: "1000",
    quoteId: "q-123",
    signature: "0xdeadbeef",
  },
};

describe("payment header codec", () => {
  it("round-trips a payload", () => {
    expect(decodePaymentHeader(encodePaymentHeader(payload))).toEqual(payload);
  });

  it("produces valid base64", () => {
    const header = encodePaymentHeader(payload);
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("round-trips non-ASCII description content", () => {
    const p = { ...payload, network: "arc-testnet — ünïcode ✓" };
    expect(decodePaymentHeader(encodePaymentHeader(p))).toEqual(p);
  });

  it("matches Buffer base64 output for interop with existing servers", () => {
    const header = encodePaymentHeader(payload);
    expect(header).toBe(Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
  });

  it("throws on garbage input", () => {
    expect(() => decodePaymentHeader("not base64 json!!!")).toThrow();
  });

  /** Regression: these are valid base64 JSON, so they used to sail past the
   *  decoder and blow up downstream on `.toLowerCase()` / `BigInt()` — every
   *  one of them produced an HTTP 500 and a stack trace instead of a 400. */
  it("rejects structurally invalid payloads instead of passing them through", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
    const cases: Record<string, unknown> = {
      "empty object": {},
      "missing payload": { scheme: "agentmesh-direct", network: "local" },
      "empty payload": { scheme: "agentmesh-direct", network: "local", payload: {} },
      "non-numeric amount": { ...payload, payload: { ...payload.payload, amount: "abc" } },
      "numeric to (type confusion)": { ...payload, payload: { ...payload.payload, to: 123 } },
      "short txHash": { ...payload, payload: { ...payload.payload, txHash: "0x1" } },
      "non-hex signature": { ...payload, payload: { ...payload.payload, signature: "nope" } },
      "wrong scheme": { ...payload, scheme: "some-other-scheme" },
      "empty quoteId": { ...payload, payload: { ...payload.payload, quoteId: "" } },
    };
    for (const [label, value] of Object.entries(cases)) {
      expect(() => decodePaymentHeader(b64(value)), label).toThrow();
    }
  });

  it("accepts a payload without an explicit x402Version", () => {
    const { x402Version: _omitted, ...rest } = payload;
    const b64 = Buffer.from(JSON.stringify(rest), "utf8").toString("base64");
    expect(decodePaymentHeader(b64).x402Version).toBe(1);
  });
});

describe("paymentSigMessage", () => {
  it("is deterministic and binds quote to tx", () => {
    const m = paymentSigMessage("q-123", payload.payload.txHash);
    expect(m).toBe(`agentmesh-x402|q-123|${payload.payload.txHash}`);
    expect(paymentSigMessage("q-456", payload.payload.txHash)).not.toBe(m);
  });
});
