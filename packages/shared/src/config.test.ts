import { describe, expect, it } from "vitest";
import { formatUsd, usd } from "./config.js";

describe("usd", () => {
  it("parses whole dollars", () => {
    expect(usd("1")).toBe(1_000_000n);
    expect(usd(25)).toBe(25_000_000n);
    expect(usd("0")).toBe(0n);
  });

  it("parses fractional amounts", () => {
    expect(usd("0.001")).toBe(1_000n);
    expect(usd("1.5")).toBe(1_500_000n);
    expect(usd(1.25)).toBe(1_250_000n);
    expect(usd("0.000001")).toBe(1n);
  });

  it("parses a bare leading dot", () => {
    expect(usd(".5")).toBe(500_000n);
  });

  it("parses negative amounts with correct sign on the fraction", () => {
    expect(usd("-1.5")).toBe(-1_500_000n);
    expect(usd("-0.25")).toBe(-250_000n);
  });

  it("parses a trailing dot", () => {
    expect(usd("3.")).toBe(3_000_000n);
  });

  it("rejects malformed input", () => {
    expect(() => usd("abc")).toThrow(/invalid USD amount/);
    expect(() => usd("1.2.3")).toThrow(/invalid USD amount/);
    expect(() => usd("")).toThrow(/invalid USD amount/);
    expect(() => usd("1e-7")).toThrow(/invalid USD amount/);
  });

  it("rejects excess precision instead of silently truncating", () => {
    expect(() => usd("0.1234567")).toThrow(/more than 6 decimal places/);
  });
});

describe("formatUsd", () => {
  it("formats whole and fractional amounts", () => {
    expect(formatUsd(1_000_000n)).toBe("$1");
    expect(formatUsd(1_500_000n)).toBe("$1.5");
    expect(formatUsd(1_000n)).toBe("$0.001");
    expect(formatUsd(0n)).toBe("$0");
  });

  it("formats negative amounts", () => {
    expect(formatUsd(-1_500_000n)).toBe("-$1.5");
    expect(formatUsd(-1n)).toBe("-$0.000001");
  });

  it("round-trips with usd()", () => {
    for (const s of ["1", "0.5", "12.345678".slice(0, 8), "0.000001"]) {
      expect(formatUsd(usd(s))).toBe(`$${s.replace(/\.?0+$/, "") || "0"}`);
    }
  });
});
