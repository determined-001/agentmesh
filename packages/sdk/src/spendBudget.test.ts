import { usd } from "@agentmesh/shared";
import { describe, expect, it } from "vitest";
import { SpendBudget } from "./spendBudget.js";

describe("SpendBudget", () => {
  it("rejects a single payment over the per-call ceiling", () => {
    const b = new SpendBudget(usd("0.10"), usd("10"));
    expect(() => b.assertAffordable(usd("0.11"))).toThrow(/per-call ceiling/);
    expect(() => b.assertAffordable(usd("0.10"))).not.toThrow();
  });

  it("rejects payments once the lifetime budget is exhausted", () => {
    const b = new SpendBudget(usd("1"), usd("2.5"));
    for (const _ of [0, 1]) {
      b.assertAffordable(usd("1"));
      b.record(usd("1"));
    }
    expect(b.spent).toBe(usd("2"));
    expect(b.remaining).toBe(usd("0.5"));
    expect(() => b.assertAffordable(usd("1"))).toThrow(/remaining spend budget/);
    expect(() => b.assertAffordable(usd("0.5"))).not.toThrow();
  });

  it("never reports a negative remaining balance", () => {
    const b = new SpendBudget(usd("5"), usd("1"));
    b.record(usd("5")); // e.g. a payment recorded before a budget was tightened
    expect(b.remaining).toBe(0n);
  });

  it("reads ceilings from the environment", () => {
    const prev = { call: process.env.X402_MAX_PER_CALL_USD, total: process.env.X402_MAX_TOTAL_USD };
    process.env.X402_MAX_PER_CALL_USD = "0.25";
    process.env.X402_MAX_TOTAL_USD = "3";
    try {
      const b = SpendBudget.fromEnv();
      expect(b.perCall).toBe(usd("0.25"));
      expect(b.total).toBe(usd("3"));
    } finally {
      process.env.X402_MAX_PER_CALL_USD = prev.call;
      process.env.X402_MAX_TOTAL_USD = prev.total;
    }
  });
});
