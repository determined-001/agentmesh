import type { Address } from "viem";
import type { NetworkName } from "./chains.js";

export interface Deployment {
  network: NetworkName;
  usdc: Address;
  agentRegistry: Address;
  complianceGate: Address;
  agentEscrow: Address;
  disputeWindow: number;
}

/** Resolve deployment addresses. Precedence: explicit env vars → deployments JSON
 *  bundled at repo root (written by the deploy scripts). */
export function loadDeployment(network: NetworkName, fromJson?: Partial<Deployment>): Deployment {
  const env = (k: string) => process.env[k] as Address | undefined;
  const d: Partial<Deployment> = { ...fromJson };
  const usdc = env("USDC_ADDRESS") ?? d.usdc;
  const agentRegistry = env("AGENT_REGISTRY_ADDRESS") ?? d.agentRegistry;
  const complianceGate = env("COMPLIANCE_GATE_ADDRESS") ?? d.complianceGate;
  const agentEscrow = env("AGENT_ESCROW_ADDRESS") ?? d.agentEscrow;
  if (!usdc || !agentRegistry || !complianceGate || !agentEscrow) {
    throw new Error(
      `Missing deployment addresses for ${network}. Run the deploy script or set USDC_ADDRESS / AGENT_REGISTRY_ADDRESS / COMPLIANCE_GATE_ADDRESS / AGENT_ESCROW_ADDRESS.`,
    );
  }
  return {
    network,
    usdc,
    agentRegistry,
    complianceGate,
    agentEscrow,
    disputeWindow: d.disputeWindow ?? Number(process.env.DISPUTE_WINDOW ?? 300),
  };
}

/** USDC ERC-20 uses 6 decimals on Arc. */
export const USDC_DECIMALS = 6;

export function usd(amount: string | number): bigint {
  const [int, frac = ""] = String(amount).split(".");
  const fracPadded = (frac + "000000").slice(0, USDC_DECIMALS);
  return BigInt(int) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded || "0");
}

export function formatUsd(amount: bigint): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const int = abs / 10n ** BigInt(USDC_DECIMALS);
  const frac = (abs % 10n ** BigInt(USDC_DECIMALS))
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${neg ? "-" : ""}$${int}${frac ? "." + frac : ""}`;
}
