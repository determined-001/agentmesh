import { defineChain } from "viem";

/** Arc Testnet — Circle's L1 for stablecoin finance. USDC is the native gas token
 *  (18 decimals at the native interface, 6 decimals at the ERC-20 interface).
 *  Values verified against docs.arc.io (2026-07): RPC rpc.testnet.arc.network,
 *  chainId 5042002, explorer testnet.arcscan.app, faucet faucet.circle.com. */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: process.env.ARC_TESTNET_EXPLORER_URL ?? "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

/** Canonical USDC ERC-20 interface on Arc Testnet (6 decimals; the native gas
 *  balance is the same asset at 18 decimals). Source: docs.arc.io contract
 *  addresses reference. */
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;

export const localAnvil = defineChain({
  id: 31337,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545"] } },
  testnet: true,
});

export type NetworkName = "local" | "arc-testnet";

export function chainFor(network: NetworkName) {
  return network === "arc-testnet" ? arcTestnet : localAnvil;
}

export function explorerTxUrl(network: NetworkName, txHash: string): string | undefined {
  if (network !== "arc-testnet") return undefined;
  return `${arcTestnet.blockExplorers.default.url}/tx/${txHash}`;
}
