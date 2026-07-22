import type { Chain, Hex } from "viem";
import { CircleWallet } from "./circle.js";
import type { AgentWallet } from "./types.js";
import { ViemEoaWallet } from "./viemEoa.js";

export { CircleWallet, type CircleWalletConfig } from "./circle.js";
export * from "./types.js";
export { ViemEoaWallet } from "./viemEoa.js";

/** Build a wallet from the environment.
 *  WALLET_PROVIDER=eoa (default): uses `privateKeyEnv` (or PRIVATE_KEY).
 *  WALLET_PROVIDER=circle: uses CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET /
 *  CIRCLE_WALLET_ID / CIRCLE_WALLET_ADDRESS. */
export function walletFromEnv(chain: Chain, privateKeyEnv = "PRIVATE_KEY"): AgentWallet {
  const provider = process.env.WALLET_PROVIDER ?? "eoa";
  if (provider === "circle") {
    const apiKey = process.env.CIRCLE_API_KEY;
    const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
    const walletId = process.env.CIRCLE_WALLET_ID;
    const address = process.env.CIRCLE_WALLET_ADDRESS as `0x${string}` | undefined;
    if (!apiKey || !entitySecret || !walletId || !address) {
      throw new Error(
        "WALLET_PROVIDER=circle requires CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID, CIRCLE_WALLET_ADDRESS",
      );
    }
    return new CircleWallet({ apiKey, entitySecret, walletId, address }, chain);
  }
  const pk = process.env[privateKeyEnv] ?? process.env.PRIVATE_KEY;
  if (!pk) throw new Error(`Missing ${privateKeyEnv} (or PRIVATE_KEY) for WALLET_PROVIDER=eoa`);
  assertDistinctRoleKeys();
  return new ViemEoaWallet(pk as Hex, chain);
}

/** Off-local, the buyer/seller/watcher roles must not share a key: the watcher
 *  key holds screener+arbiter powers, and one leaked key must never be all
 *  three identities. (DASHBOARD_PRIVATE_KEY may mirror the buyer by design —
 *  the dashboard acts as the buyer's oversight surface.) */
function assertDistinctRoleKeys(): void {
  if ((process.env.AGENTMESH_NETWORK ?? "local") === "local") return;
  const roles = ["BUYER_PRIVATE_KEY", "SELLER_PRIVATE_KEY", "WATCHER_PRIVATE_KEY"] as const;
  const seen = new Map<string, string>();
  for (const role of roles) {
    const key = process.env[role]?.toLowerCase();
    if (!key) continue;
    const other = seen.get(key);
    if (other) {
      throw new Error(
        `${role} and ${other} share the same private key — roles must use distinct keys off-local`,
      );
    }
    seen.set(key, role);
  }
}
