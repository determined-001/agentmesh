import {
  createPublicClient,
  encodeFunctionData,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { AgentWallet, WriteContractParams } from "./types.js";

export interface CircleWalletConfig {
  apiKey: string; // Circle Developer Console API key
  entitySecret: string; // Circle entity secret (ciphertext generated per request by the SDK)
  walletId: string; // Developer-Controlled Wallet id (SCA on ARC-TESTNET)
  address: Address; // the wallet's on-chain address
}

/** Circle Developer-Controlled Wallets adapter (MPC-secured SCA accounts on
 *  ARC-TESTNET). Transactions are submitted through Circle's
 *  createContractExecutionTransaction API rather than signed locally.
 *
 *  Activated with WALLET_PROVIDER=circle plus CIRCLE_API_KEY,
 *  CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID, CIRCLE_WALLET_ADDRESS.
 *  The @circle-fin/developer-controlled-wallets package is an optional
 *  dependency; this adapter loads it lazily so the EOA path never needs it. */
export class CircleWallet implements AgentWallet {
  readonly kind = "circle" as const;
  readonly publicClient: PublicClient;
  private readonly config: CircleWalletConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any | undefined;

  constructor(config: CircleWalletConfig, chain: Chain) {
    this.config = config;
    this.publicClient = createPublicClient({ chain, transport: http() });
  }

  private async sdk() {
    if (!this.client) {
      const mod = await import("@circle-fin/developer-controlled-wallets");
      this.client = mod.initiateDeveloperControlledWalletsClient({
        apiKey: this.config.apiKey,
        entitySecret: this.config.entitySecret,
      });
    }
    return this.client;
  }

  async getAddress(): Promise<Address> {
    return this.config.address;
  }

  async writeContract(params: WriteContractParams): Promise<Hex> {
    const client = await this.sdk();
    const callData = encodeFunctionData({
      abi: params.abi,
      functionName: params.functionName,
      args: params.args as unknown[],
    });
    const res = await client.createContractExecutionTransaction({
      walletId: this.config.walletId,
      contractAddress: params.address,
      callData,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txId: string = res.data?.id;
    // Poll Circle until the transaction lands on-chain and a hash is available.
    for (let i = 0; i < 60; i++) {
      const tx = await client.getTransaction({ id: txId });
      const state: string = tx.data?.transaction?.state;
      const hash: Hex | undefined = tx.data?.transaction?.txHash;
      if (state === "FAILED" || state === "DENIED") {
        throw new Error(`Circle transaction ${txId} ${state}: ${tx.data?.transaction?.errorReason ?? ""}`);
      }
      if (hash && (state === "CONFIRMED" || state === "COMPLETE" || state === "SENT")) return hash;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Circle transaction ${txId} did not confirm in time`);
  }

  async waitForReceipt(txHash: Hex): Promise<TransactionReceipt> {
    return this.publicClient.waitForTransactionReceipt({ hash: txHash });
  }
}
