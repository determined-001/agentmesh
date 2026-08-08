import { usd } from "@agentmesh/shared";

/** A hard ceiling on what a process may spend over x402, independent of any
 *  per-call cap the caller passes in.
 *
 *  This exists because the MCP server hands `pay_x402` to a language model:
 *  the per-call cap is an argument the model chooses, and the content being
 *  fetched is exactly the channel an attacker uses to influence that choice.
 *  A budget the model cannot see or set is the only limit that survives prompt
 *  injection. Configure with X402_MAX_PER_CALL_USD / X402_MAX_TOTAL_USD. */
export class SpendBudget {
  private spentUnits = 0n;

  constructor(
    readonly perCall: bigint,
    readonly total: bigint,
  ) {}

  static fromEnv(): SpendBudget {
    return new SpendBudget(
      usd(process.env.X402_MAX_PER_CALL_USD ?? "0.10"),
      usd(process.env.X402_MAX_TOTAL_USD ?? "10"),
    );
  }

  get spent(): bigint {
    return this.spentUnits;
  }

  get remaining(): bigint {
    const left = this.total - this.spentUnits;
    return left > 0n ? left : 0n;
  }

  /** Throws unless `amount` fits both the per-call and lifetime ceilings. */
  assertAffordable(amount: bigint): void {
    if (amount > this.perCall) {
      throw new Error(`payment of ${amount} base units exceeds the per-call ceiling of ${this.perCall}`);
    }
    if (this.spentUnits + amount > this.total) {
      throw new Error(
        `payment of ${amount} base units exceeds the remaining spend budget (${this.remaining} of ${this.total})`,
      );
    }
  }

  record(amount: bigint): void {
    this.spentUnits += amount;
  }
}
