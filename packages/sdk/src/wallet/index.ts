import type { Chain, Hex } from "viem";
import type { AgentWallet } from "./types.js";
import { ViemEoaWallet } from "./viemEoa.js";
import { CircleWallet } from "./circle.js";

export * from "./types.js";
export { ViemEoaWallet } from "./viemEoa.js";
export { CircleWallet, type CircleWalletConfig } from "./circle.js";

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
        "WALLET_PROVIDER=circle requires CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID, CIRCLE_WALLET_ADDRESS"
      );
    }
    return new CircleWallet({ apiKey, entitySecret, walletId, address }, chain);
  }
  const pk = process.env[privateKeyEnv] ?? process.env.PRIVATE_KEY;
  if (!pk) throw new Error(`Missing ${privateKeyEnv} (or PRIVATE_KEY) for WALLET_PROVIDER=eoa`);
  return new ViemEoaWallet(pk as Hex, chain);
}
