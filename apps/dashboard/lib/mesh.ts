import { AgentMeshClient, type AgentWallet, CircleWallet, readDeployment } from "@agentmesh/sdk";
import { chainFor, type NetworkName } from "@agentmesh/shared";
import type { Address, Hex, TransactionReceipt } from "viem";

export const network = (process.env.AGENTMESH_NETWORK ?? "local") as NetworkName;

/** Stands in for a wallet on the read-only tools. Every read the SDK exposes goes
 *  through `publicClient`, so the only thing missing is a signer — and a connector
 *  that anyone on the internet can add must not have one by default. */
class ReadOnlyWallet implements AgentWallet {
  readonly kind = "eoa" as const;
  private fail(): never {
    throw new Error("This tool needs a wallet. Call create_agent_wallet first, then pass its walletId.");
  }
  async getAddress(): Promise<Address> {
    return this.fail();
  }
  async writeContract(): Promise<Hex> {
    return this.fail();
  }
  async waitForReceipt(): Promise<TransactionReceipt> {
    return this.fail();
  }
  async signMessage(): Promise<Hex> {
    return this.fail();
  }
}

/** Deployment addresses resolve from the *_ADDRESS env overrides on Vercel (there is
 *  no deployments/ dir in the bundle); readDeployment falls back to them. */
function deployment() {
  return readDeployment(network);
}

let readOnly: AgentMeshClient | undefined;

export function readOnlyMesh(): AgentMeshClient {
  if (!readOnly) {
    readOnly = new AgentMeshClient(chainFor(network), deployment(), new ReadOnlyWallet());
  }
  return readOnly;
}

/** Circle developer-controlled wallet for one connector user. `pollAttempts` is kept
 *  short: a serverless invocation has ~60s, well under CircleWallet's default wait. */
export function meshForWallet(walletId: string, address: Address): AgentMeshClient {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error("Wallet tools are unavailable: CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET not set.");
  }
  const chain = chainFor(network);
  const wallet = new CircleWallet({ apiKey, entitySecret, walletId, address, pollAttempts: 18 }, chain);
  return new AgentMeshClient(chain, deployment(), wallet);
}

/** Minimal slice of the Circle SDK used to mint a wallet. Declared structurally for
 *  the same reason the SDK's adapter does: the package is an optional dependency. */
interface CircleWalletsSdk {
  createWallets(params: {
    walletSetId: string;
    accountType: string;
    blockchains: string[];
    count: number;
    metadata?: { name: string }[];
  }): Promise<{ data?: { wallets?: { id: string; address: Address }[] } }>;
  getWallet(params: { id: string }): Promise<{ data?: { wallet?: { id: string; address: Address } } }>;
  getTransaction(params: { id: string }): Promise<{
    data?: { transaction?: { state?: string; txHash?: string; errorReason?: string } };
  }>;
}

/** Where a connector user tops up the wallet the connector minted for them. */
export const FAUCET_URL = "https://faucet.circle.com";

export async function circleSdk(): Promise<CircleWalletsSdk> {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error("Wallet tools are unavailable: CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET not set.");
  }
  const mod = await import("@circle-fin/developer-controlled-wallets");
  return mod.initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  }) as unknown as CircleWalletsSdk;
}

export function walletSetId(): string {
  const id = process.env.CIRCLE_WALLET_SET_ID;
  if (!id) throw new Error("Wallet tools are unavailable: CIRCLE_WALLET_SET_ID not set.");
  return id;
}

/** Circle's chain identifier for the network this connector is pointed at. */
export const circleBlockchain = network === "arc-testnet" ? "ARC-TESTNET" : "ARC";
