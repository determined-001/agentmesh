import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SellerStore } from "./store.js";

/** The durable SQLite claim path is a separate implementation from the
 *  in-memory one in createX402State — and it is the one that runs in
 *  production, so it gets its own coverage. */
describe("SellerStore.claim", () => {
  let store: SellerStore;
  const TX = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const OTHER_TX = "0x2222222222222222222222222222222222222222222222222222222222222222";
  const RESOURCE = "/api/headline";

  const quote = (id: string, validUntil = Date.now() + 60_000, resource = RESOURCE) =>
    store.setQuote(id, { resource, price: 1_000n, validUntil });

  beforeEach(() => {
    store = new SellerStore(":memory:", "0xescrow|0xgenesis");
    quote("q1");
  });

  it("consumes the quote and marks the tx spent", () => {
    expect(store.claim("q1", TX, RESOURCE, Date.now())).toEqual({ ok: true, idempotent: false });
    expect(store.getConsumed("q1")).toBe(TX);
    expect(store.hasUsedTx(TX)).toBe(true);
    expect(store.getQuote("q1")).toBeUndefined();
  });

  it("re-presenting the same quote and tx is idempotent", () => {
    store.claim("q1", TX, RESOURCE, Date.now());
    expect(store.claim("q1", TX, RESOURCE, Date.now())).toEqual({ ok: true, idempotent: true });
  });

  it("rejects a second tx against an already-claimed quote", () => {
    store.claim("q1", TX, RESOURCE, Date.now());
    expect(store.claim("q1", OTHER_TX, RESOURCE, Date.now())).toMatchObject({
      ok: false,
      error: "quote already claimed",
    });
  });

  it("rejects one payment spent across two distinct quotes", () => {
    quote("q2");
    expect(store.claim("q1", TX, RESOURCE, Date.now())).toEqual({ ok: true, idempotent: false });
    // The double-spend: same on-chain payment, fresh quote.
    expect(store.claim("q2", TX, RESOURCE, Date.now())).toMatchObject({
      ok: false,
      error: "payment already used",
    });
    // The losing claim must not have consumed q2 — it stays claimable by a real payment.
    expect(store.getConsumed("q2")).toBeUndefined();
    expect(store.getQuote("q2")).toBeDefined();
  });

  it("rejects unknown, expired and mismatched-resource quotes", () => {
    expect(store.claim("nope", TX, RESOURCE, Date.now())).toMatchObject({
      ok: false,
      error: "unknown or expired quote",
    });
    quote("old", Date.now() - 1);
    expect(store.claim("old", TX, RESOURCE, Date.now())).toMatchObject({ ok: false, error: "quote expired" });
    expect(store.claim("q1", TX, "/api/datapoint", Date.now())).toMatchObject({
      ok: false,
      error: "quote is for another resource",
    });
  });

  it("replay protection survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmesh-store-"));
    const path = join(dir, "seller.sqlite");
    const scope = "0xescrow|0xgenesis";
    try {
      const first = new SellerStore(path, scope);
      first.setQuote("q1", { resource: RESOURCE, price: 1_000n, validUntil: Date.now() + 60_000 });
      expect(first.claim("q1", TX, RESOURCE, Date.now())).toEqual({ ok: true, idempotent: false });
      first.close();

      // Same deployment scope, so the store must NOT wipe — a restart is not a
      // reset, and a spent payment has to stay spent across one.
      const second = new SellerStore(path, scope);
      second.setQuote("q2", { resource: RESOURCE, price: 1_000n, validUntil: Date.now() + 60_000 });
      expect(second.claim("q2", TX, RESOURCE, Date.now())).toMatchObject({
        ok: false,
        error: "payment already used",
      });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
