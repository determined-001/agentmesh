import { defineChain } from "viem";

/** Arc Testnet — Circle's L1 for stablecoin finance. USDC is the native gas token
 *  (18 decimals at the native interface, 6 decimals at the ERC-20 interface). */
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
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.network" },
  },
  testnet: true,
});

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
