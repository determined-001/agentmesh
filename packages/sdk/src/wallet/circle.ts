import {
  type Address,
  type Chain,
  createPublicClient,
  encodeFunctionData,
  type Hex,
  http,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { AgentWallet, WriteContractParams } from "./types.js";

/** The slice of @circle-fin/developer-controlled-wallets this adapter uses.
 *  Declared structurally rather than imported: the package is an optional
 *  dependency loaded lazily, so the EOA path never needs it installed. */
interface CircleSdk {
  createContractExecutionTransaction(params: {
    walletId: string;
    contractAddress: Address;
    callData: Hex;
    fee: { type: string; config: { feeLevel: string } };
  }): Promise<{ data?: { id: string } }>;
  getTransaction(params: { id: string }): Promise<{
    data?: { transaction?: { state?: string; txHash?: Hex; errorReason?: string } };
  }>;
  signMessage(params: { walletId: string; message: string }): Promise<{ data?: { signature?: Hex } }>;
}

export interface CircleWalletConfig {
  apiKey: string; // Circle Developer Console API key
  entitySecret: string; // Circle entity secret (ciphertext generated per request by the SDK)
  walletId: string; // Developer-Controlled Wallet id (SCA on ARC-TESTNET)
  address: Address; // the wallet's on-chain address
  /** How many 2s polls to wait for Circle to land the transaction. Default 60
   *  (two minutes) suits a long-running service; a serverless caller has a hard
   *  invocation ceiling and should pass a smaller number, then report the
   *  Circle transaction id so the caller can poll separately. */
  pollAttempts?: number;
}

/** Thrown when Circle accepted the transaction but it had not landed before the
 *  poll budget ran out. Carries the Circle transaction id so the caller can keep
 *  checking instead of assuming failure — the transaction is still in flight. */
export class CirclePendingError extends Error {
  constructor(readonly circleTxId: string) {
    super(`Circle transaction ${circleTxId} is still pending`);
    this.name = "CirclePendingError";
  }
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
  private client: CircleSdk | undefined;

  constructor(config: CircleWalletConfig, chain: Chain) {
    this.config = config;
    this.publicClient = createPublicClient({
      chain,
      transport: http(undefined, { retryCount: 3, retryDelay: 300, timeout: 15_000 }),
    });
  }

  private async sdk(): Promise<CircleSdk> {
    if (!this.client) {
      const mod = await import("@circle-fin/developer-controlled-wallets");
      this.client = mod.initiateDeveloperControlledWalletsClient({
        apiKey: this.config.apiKey,
        entitySecret: this.config.entitySecret,
      }) as unknown as CircleSdk;
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
    const txId = res.data?.id;
    // Previously typed as `string` over an optional field: a Circle response
    // without an id silently became `undefined` and was polled as one.
    if (!txId) throw new Error("Circle createContractExecutionTransaction returned no transaction id");
    // Poll Circle until the transaction lands on-chain and a hash is available.
    const attempts = this.config.pollAttempts ?? 60;
    for (let i = 0; i < attempts; i++) {
      const tx = await client.getTransaction({ id: txId });
      const state = tx.data?.transaction?.state;
      const hash: Hex | undefined = tx.data?.transaction?.txHash;
      if (state === "FAILED" || state === "DENIED") {
        throw new Error(`Circle transaction ${txId} ${state}: ${tx.data?.transaction?.errorReason ?? ""}`);
      }
      if (hash && (state === "CONFIRMED" || state === "COMPLETE" || state === "SENT")) return hash;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new CirclePendingError(txId);
  }

  async waitForReceipt(txHash: Hex): Promise<TransactionReceipt> {
    return this.publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  async signMessage(message: string): Promise<Hex> {
    const sdk = await this.sdk();
    const res = await sdk.signMessage({ walletId: this.config.walletId, message });
    const signature = res?.data?.signature as Hex | undefined;
    if (!signature) throw new Error("Circle signMessage returned no signature");
    return signature;
  }
}
